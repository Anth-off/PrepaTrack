#include <metal_stdlib>
using namespace metal;

struct MixerParameters {
    float2 pipPosition;
    float2 pipSize;
    float2 labelPosition;
    float2 labelSize;
    float pipBorderWidth;
};

constant sampler linearSampler(filter::linear, coord::pixel, address::clamp_to_edge);

kernel void prepaTrackDualCameraMixer(
    texture2d<half, access::read> fullScreenInput [[texture(0)]],
    texture2d<half, access::sample> pipInput [[texture(1)]],
    texture2d<half, access::sample> labelInput [[texture(2)]],
    texture2d<half, access::write> outputTexture [[texture(3)]],
    constant MixerParameters& parameters [[buffer(0)]],
    uint2 gid [[thread_position_in_grid]]
) {
    if (gid.x >= outputTexture.get_width() || gid.y >= outputTexture.get_height()) {
        return;
    }

    half4 output = fullScreenInput.read(gid);
    float2 point = float2(gid);
    bool insidePip = all(point >= parameters.pipPosition) &&
        all(point < parameters.pipPosition + parameters.pipSize);
    if (insidePip) {
        float2 local = point - parameters.pipPosition;
        bool border = local.x < parameters.pipBorderWidth ||
            local.y < parameters.pipBorderWidth ||
            local.x >= parameters.pipSize.x - parameters.pipBorderWidth ||
            local.y >= parameters.pipSize.y - parameters.pipBorderWidth;
        if (border) {
            output = half4(1.0h);
        } else {
            float2 sampling = local *
                float2(pipInput.get_width(), pipInput.get_height()) / parameters.pipSize;
            output = pipInput.sample(linearSampler, sampling + 0.5);
        }
    }

    bool insideLabel = all(point >= parameters.labelPosition) &&
        all(point < parameters.labelPosition + parameters.labelSize);
    if (insideLabel) {
        float2 local = point - parameters.labelPosition;
        float2 sampling = local *
            float2(labelInput.get_width(), labelInput.get_height()) / parameters.labelSize;
        half4 label = labelInput.sample(linearSampler, sampling + 0.5);
        output = label + output * (1.0h - label.a);
    }

    outputTexture.write(output, gid);
}
