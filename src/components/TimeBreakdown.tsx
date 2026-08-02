import type { DayMetrics } from '../core/metrics'
import { segmentDef } from '../core/segments'
import type { SegmentType } from '../core/types'
import { formatShort } from '../core/time'

interface Props {
  day: DayMetrics
}

/** Répartition du temps de la journée : barre empilée puis détail chiffré. */
export function TimeBreakdown({ day }: Props) {
  const entries = (Object.entries(day.byType) as [SegmentType, number][])
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1])

  if (day.presence === 0) return null

  return (
    <div className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Répartition du temps
      </h3>

      <div className="mt-3 flex h-4 overflow-hidden rounded-full bg-ink-600">
        {entries.map(([type, ms]) => (
          <div
            key={type}
            className={segmentDef(type).color}
            style={{ width: `${(ms / day.presence) * 100}%` }}
            title={`${segmentDef(type).label} — ${formatShort(ms)}`}
          />
        ))}
      </div>

      <ul className="mt-3 space-y-1.5">
        {entries.map(([type, ms]) => (
          <li key={type} className="flex items-center gap-2 text-sm">
            <span className={`h-3 w-3 shrink-0 rounded-sm ${segmentDef(type).color}`} />
            <span className="flex-1 truncate">
              {segmentDef(type).label}
              {day.countByType[type] && day.countByType[type]! > 1 && (
                <span className="ml-1 text-slate-500">×{day.countByType[type]}</span>
              )}
            </span>
            <span className="tabular font-semibold">{formatShort(ms)}</span>
            <span className="tabular w-12 text-right text-slate-500">
              {Math.round((ms / day.presence) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
