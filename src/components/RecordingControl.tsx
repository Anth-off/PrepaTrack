import { useNow } from '../hooks/useNow'
import type { RecordingControl as Control } from '../hooks/useRecording'
import { formatShort } from '../core/time'

export function RecordingControl({ recording }: { recording: Control }) {
  const now = useNow(1_000)
  if (recording.status === 'disabled') return null
  const active = ['recording', 'stopping'].includes(recording.status)
  return (
    <div className="flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-800 px-3 py-1.5">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${active ? 'animate-pulse bg-bad' : 'bg-slate-600'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold">
          {active
            ? `Enregistrement visible · ${formatShort(Math.max(0, now - (recording.startedAt ?? now)))}`
            : recording.status === 'requesting'
              ? 'Autorisation caméra et micro…'
              : recording.status === 'interrupted'
                ? 'Enregistrement interrompu'
                : recording.status === 'error'
                  ? 'Enregistrement indisponible'
                  : 'Caméra avant + micro'}
        </div>
        {recording.message && <div className="truncate text-[0.65rem] text-slate-500">{recording.message}</div>}
      </div>
      <button
        type="button"
        disabled={recording.status === 'requesting' || recording.status === 'stopping'}
        onClick={() => void (active ? recording.stop('complete') : recording.start())}
        className={`pressable min-h-[2.25rem] shrink-0 rounded-lg px-3 text-xs font-bold ${active ? 'bg-bad text-white' : 'bg-ink-700 text-slate-200'}`}
      >
        {active ? 'Arrêter' : 'Démarrer'}
      </button>
    </div>
  )
}
