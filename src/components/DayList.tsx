import { isRateMeaningful } from '../core/metrics'
import { formatDayLabel, formatShort } from '../core/time'
import type { RecentDay } from '../hooks/useRecentDays'

interface Props {
  days: RecentDay[]
  targetRate: number
  onOpen: (workdayId: string) => void
}

/** Liste des vacations, la plus récente en tête. */
export function DayList({ days, targetRate, onOpen }: Props) {
  if (days.length === 0) {
    return (
      <p className="py-8 text-center text-slate-500">
        Aucune journée enregistrée pour l'instant.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {days.map((row) => {
        const shown = row.metrics.rates.day > 0 && isRateMeaningful(row.metrics.worked)
        const ratio = targetRate > 0 ? row.metrics.rates.day / targetRate : 0
        const tone = !shown
          ? 'text-slate-600'
          : ratio >= 1
            ? 'text-ok'
            : ratio >= 0.9
              ? 'text-warn'
              : 'text-bad'

        return (
          <button
            key={row.id}
            type="button"
            onClick={() => onOpen(row.id)}
            className="pressable card flex items-center justify-between text-left"
          >
            <div>
              <div className="font-bold first-letter:uppercase">
                {formatDayLabel(row.date)}
                {row.open && <span className="ml-2 text-sm text-accent">en cours</span>}
              </div>
              <div className="tabular text-sm text-slate-500">
                {row.metrics.colis} colis · {row.metrics.ordersCount} cde ·{' '}
                {formatShort(row.metrics.presence)}
              </div>
            </div>
            <div className={`tabular text-2xl font-bold ${tone}`}>
              {shown ? Math.round(row.metrics.rates.day) : '—'}
              {shown && <span className="text-sm text-slate-500">/h</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}
