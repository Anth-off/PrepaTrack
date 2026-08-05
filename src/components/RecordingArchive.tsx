import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { formatShort, hhmm } from '../core/time'
import {
  deleteRecordingChunk,
  downloadRecording,
  listRecordingChunks,
  type RecordingChunk,
} from '../db/recordings'

function sizeLabel(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} Mo` : `${Math.ceil(bytes / 1_000)} ko`
}

export function RecordingArchive({ workdayId }: { workdayId: string }) {
  const rows = useLiveQuery(() => listRecordingChunks(workdayId), [workdayId]) ?? []
  const [playing, setPlaying] = useState<RecordingChunk>()
  const url = useMemo(() => playing ? URL.createObjectURL(playing.blob) : undefined, [playing])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  if (rows.length === 0) return null
  const total = rows.reduce((sum, row) => sum + row.size, 0)
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Enregistrements locaux</h3>
        <span className="text-xs text-slate-500">{rows.length} extrait{rows.length > 1 ? 's' : ''} · {sizeLabel(total)}</span>
      </div>
      <p className="mb-2 text-xs text-slate-500">Ces fichiers restent sur cet appareil et ne sont jamais synchronisés.</p>
      {url && playing && (
        <div className="card mb-2">
          <video src={url} controls playsInline className="max-h-80 w-full rounded-xl bg-black" />
        </div>
      )}
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.id} className="card flex items-center gap-2 py-3">
            <button type="button" onClick={() => setPlaying(row)} className="pressable min-w-0 flex-1 text-left">
              <div className="text-sm font-bold">{hhmm(row.startedAt)} · {formatShort(row.duration)}</div>
              <div className="text-xs text-slate-500">{sizeLabel(row.size)}{row.status === 'interrupted' ? ' · interrompu' : ''}</div>
            </button>
            <button type="button" onClick={() => downloadRecording(row)} className="pressable rounded-lg bg-ink-700 px-3 py-2 text-xs font-semibold">Exporter</button>
            <button
              type="button"
              aria-label={`Supprimer l’extrait de ${hhmm(row.startedAt)}`}
              onClick={() => {
                if (window.confirm('Supprimer définitivement cet extrait local ?')) {
                  if (playing?.id === row.id) setPlaying(undefined)
                  void deleteRecordingChunk(row.id)
                }
              }}
              className="pressable rounded-lg border border-bad/40 px-3 py-2 text-xs font-semibold text-bad"
            >
              Supprimer
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
