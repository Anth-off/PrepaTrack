import Foundation
import llama

public enum OfflineLlamaError: Error {
    case modelLoad
    case contextLoad
    case promptTooLong
    case decode
}

private func batchClear(_ batch: inout llama_batch) { batch.n_tokens = 0 }

private func batchAdd(
    _ batch: inout llama_batch,
    token: llama_token,
    position: llama_pos,
    logits: Bool
) {
    let index = Int(batch.n_tokens)
    batch.token[index] = token
    batch.pos[index] = position
    batch.n_seq_id[index] = 1
    batch.seq_id[index]![0] = 0
    batch.logits[index] = logits ? 1 : 0
    batch.n_tokens += 1
}

/** Instance courte : elle est libérée après chaque diagnostic pour rendre la mémoire aux caméras. */
public actor OfflineLlamaEngine {
    private let model: OpaquePointer
    private let context: OpaquePointer
    private let vocab: OpaquePointer
    private let sampler: UnsafeMutablePointer<llama_sampler>
    private var batch: llama_batch

    public init(modelURL: URL) throws {
        llama_backend_init()
        var modelParameters = llama_model_default_params()
        // Le CPU/Accelerate est volontaire : la double capture utilise déjà Metal.
        modelParameters.n_gpu_layers = 0
        guard let model = llama_model_load_from_file(modelURL.path, modelParameters) else {
            throw OfflineLlamaError.modelLoad
        }
        var contextParameters = llama_context_default_params()
        contextParameters.n_ctx = 2_048
        let threads = max(1, min(4, ProcessInfo.processInfo.processorCount - 2))
        contextParameters.n_threads = Int32(threads)
        contextParameters.n_threads_batch = Int32(threads)
        guard let context = llama_init_from_model(model, contextParameters) else {
            llama_model_free(model)
            throw OfflineLlamaError.contextLoad
        }
        self.model = model
        self.context = context
        self.vocab = llama_model_get_vocab(model)
        self.batch = llama_batch_init(2_048, 0, 1)
        let parameters = llama_sampler_chain_default_params()
        self.sampler = llama_sampler_chain_init(parameters)
        llama_sampler_chain_add(self.sampler, llama_sampler_init_temp(0.1))
        llama_sampler_chain_add(self.sampler, llama_sampler_init_dist(0x50524550))
    }

    deinit {
        llama_sampler_free(sampler)
        llama_batch_free(batch)
        llama_free(context)
        llama_model_free(model)
        llama_backend_free()
    }

    public func generate(prompt: String, maximumTokens: Int32 = 96) throws -> String {
        llama_memory_clear(llama_get_memory(context), true)
        llama_sampler_reset(sampler)
        let tokens = tokenize(prompt)
        guard !tokens.isEmpty, tokens.count + Int(maximumTokens) <= 2_048 else {
            throw OfflineLlamaError.promptTooLong
        }
        batchClear(&batch)
        for (index, token) in tokens.enumerated() {
            batchAdd(&batch, token: token, position: Int32(index), logits: index == tokens.count - 1)
        }
        guard llama_decode(context, batch) == 0 else { throw OfflineLlamaError.decode }

        var position = Int32(tokens.count)
        var output = ""
        var invalidBytes: [CChar] = []
        for _ in 0..<maximumTokens {
            let token = llama_sampler_sample(sampler, context, batch.n_tokens - 1)
            if llama_vocab_is_eog(vocab, token) { break }
            invalidBytes.append(contentsOf: tokenPiece(token))
            if let text = String(validatingUTF8: invalidBytes + [0]) {
                output += text
                invalidBytes.removeAll(keepingCapacity: true)
            }
            batchClear(&batch)
            batchAdd(&batch, token: token, position: position, logits: true)
            guard llama_decode(context, batch) == 0 else { throw OfflineLlamaError.decode }
            position += 1
        }
        if !invalidBytes.isEmpty { output += String(cString: invalidBytes + [0]) }
        return output
    }

    private func tokenize(_ text: String) -> [llama_token] {
        let capacity = text.utf8.count + 8
        let pointer = UnsafeMutablePointer<llama_token>.allocate(capacity: capacity)
        defer { pointer.deallocate() }
        let count = llama_tokenize(vocab, text, Int32(text.utf8.count), pointer, Int32(capacity), true, true)
        guard count > 0 else { return [] }
        return (0..<Int(count)).map { pointer[$0] }
    }

    private func tokenPiece(_ token: llama_token) -> [CChar] {
        var buffer = [CChar](repeating: 0, count: 16)
        let count = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        if count >= 0 { return Array(buffer.prefix(Int(count))) }
        buffer = [CChar](repeating: 0, count: Int(-count))
        let finalCount = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        return finalCount > 0 ? Array(buffer.prefix(Int(finalCount))) : []
    }
}
