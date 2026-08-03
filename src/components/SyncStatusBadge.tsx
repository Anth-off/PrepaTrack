import type { SyncStatus } from '../sync/status'

const TONES: Record<SyncStatus['state'], string> = {
  local: 'bg-slate-500',
  offline: 'bg-slate-400',
  pending: 'bg-warn',
  running: 'bg-info animate-pulse',
  'up-to-date': 'bg-ok',
  error: 'bg-bad',
}

export function SyncStatusBadge({ status, compact = false }: { status: SyncStatus; compact?: boolean }) {
  return (
    <span
      title={status.detail}
      aria-label={`Synchronisation : ${status.label}`}
      className={compact ? 'inline-flex' : 'inline-flex items-center gap-2 text-sm font-bold'}
    >
      <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${TONES[status.state]}`} />
      {!compact && status.label}
    </span>
  )
}
