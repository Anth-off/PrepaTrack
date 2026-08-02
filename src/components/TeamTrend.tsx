import type { DayData } from '../core/analysis'
import { isRateMeaningful } from '../core/metrics'
import { formatDayLabel } from '../core/time'

interface Props {
  days: DayData[]
  targetRate: number
}

/**
 * Cadence de l'équipe, jour par jour.
 *
 * Les vacations d'une même date sont additionnées avant d'être converties en
 * cadence — pas moyennées. Faire la moyenne des cadences individuelles donnerait
 * autant de poids à une demi-journée qu'à un poste complet.
 */
export function TeamTrend({ days, targetRate }: Props) {
  const byDate = new Map<string, { colis: number; worked: number; people: Set<string> }>()

  for (const day of days) {
    const current = byDate.get(day.date) ?? { colis: 0, worked: 0, people: new Set<string>() }
    current.colis += day.metrics.colis
    current.worked += day.metrics.worked
    const owner = day.segments.find((s) => s.ownerId)?.ownerId
    if (owner) current.people.add(owner)
    byDate.set(day.date, current)
  }

  const points = [...byDate.entries()]
    .filter(([, v]) => v.colis > 0 && isRateMeaningful(v.worked))
    .map(([date, v]) => ({
      date,
      rate: v.colis / (v.worked / 3_600_000),
      colis: v.colis,
      people: v.people.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  if (points.length === 0) return null

  const best = Math.max(targetRate, ...points.map((p) => p.rate))

  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Cadence de l'équipe
        </h3>
        <span className="tabular text-xs text-slate-500">objectif {targetRate}/h</span>
      </div>

      <div className="relative mt-4 flex h-36 items-end gap-1.5">
        <div
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-500/60"
          style={{ bottom: `${(targetRate / best) * 100}%` }}
        />
        {points.map((point) => (
          <div
            key={point.date}
            className="flex h-full max-w-[5rem] flex-1 flex-col justify-end"
            title={`${formatDayLabel(point.date)} — ${Math.round(point.rate)} colis/h, ${point.people} préparateur(s)`}
          >
            <span className="tabular mb-1 text-center text-[0.6rem] font-bold text-slate-400">
              {Math.round(point.rate)}
            </span>
            <span
              className={`w-full rounded-t ${point.rate >= targetRate ? 'bg-ok' : 'bg-warn'}`}
              style={{ height: `${Math.max(2, (point.rate / best) * 100)}%` }}
            />
            <span className="mt-1 text-center text-[0.6rem] text-slate-600">
              {point.date.slice(8)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
