import { isRateMeaningful, type DayMetrics } from '../core/metrics'
import { formatShort } from '../core/time'

interface Props {
  day: DayMetrics
  targetRate: number
}

/**
 * Les trois cadences côte à côte. Les afficher ensemble est volontaire : l'écart
 * entre la prépa pure et la cadence journée est exactement ce qu'il faut
 * regarder pour savoir où part le temps.
 */
export function RateCards({ day, targetRate }: Props) {
  const cards = [
    {
      key: 'picking',
      label: 'Prépa pure',
      value: day.rates.picking,
      window: day.pickingTime,
      hint: `sur ${formatShort(day.pickingTime)} de prélèvement`,
    },
    {
      key: 'order',
      label: 'Commande',
      value: day.rates.order,
      window: day.orderTime,
      hint: `sur ${formatShort(day.orderTime)}, pauses exclues`,
    },
    {
      key: 'day',
      label: 'Journée',
      value: day.rates.day,
      window: day.worked,
      hint: `sur ${formatShort(day.worked)}, pause 30 min exclue`,
    },
  ]

  return (
    <div className="grid grid-cols-3 gap-2">
      {cards.map((c) => {
        const shown = c.value > 0 && isRateMeaningful(c.window)
        const ratio = targetRate > 0 ? c.value / targetRate : 0
        const tone = !shown
          ? 'text-slate-600'
          : ratio >= 1
            ? 'text-ok'
            : ratio >= 0.9
              ? 'text-warn'
              : 'text-bad'
        return (
          <div key={c.key} className="card px-3 py-3">
            <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
              {c.label}
            </div>
            <div className={`tabular text-3xl font-bold ${tone}`}>
              {shown ? Math.round(c.value) : '—'}
            </div>
            <div className="text-[0.65rem] leading-tight text-slate-500">{c.hint}</div>
          </div>
        )
      })}
    </div>
  )
}
