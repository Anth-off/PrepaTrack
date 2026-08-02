import { isRateMeaningful } from '../core/metrics'
import type { RecentDay } from '../hooks/useRecentDays'

interface Props {
  days: RecentDay[]
  targetRate: number
  onSelect: (workdayId: string) => void
}

/**
 * Cadence journée des dernières vacations, la plus ancienne à gauche.
 *
 * Barres en CSS plutôt qu'une bibliothèque de graphiques : l'application doit
 * démarrer instantanément en mode avion, et 100 ko de JavaScript de plus pour
 * dessiner sept rectangles seraient payés à chaque lancement.
 */
export function DayBars({ days, targetRate, onSelect }: Props) {
  // Une vacation sans colis (journée ouverte par erreur, briefing seul) tracerait
  // une barre à zéro qui écraserait l'échelle sans rien apprendre.
  const shown = [...days]
    .reverse()
    .filter((d) => d.metrics.colis > 0 && isRateMeaningful(d.metrics.worked))
  if (shown.length === 0) return null

  const best = Math.max(targetRate, ...shown.map((d) => d.metrics.rates.day))

  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Cadence journée
        </h3>
        <span className="tabular text-xs text-slate-500">objectif {targetRate}/h</span>
      </div>

      <div className="relative mt-4 flex h-40 items-end gap-1.5">
        {/* Repère de l'objectif, pour situer chaque barre d'un coup d'œil. */}
        <div
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-500/60"
          style={{ bottom: `${(targetRate / best) * 100}%` }}
        />
        {shown.map((day) => {
          const value = day.metrics.rates.day
          const height = Math.max(2, (value / best) * 100)
          const reached = value >= targetRate
          return (
            <button
              key={day.id}
              type="button"
              onClick={() => onSelect(day.id)}
              // Largeur plafonnée : avec une seule vacation, une barre pleine
              // largeur ressemble à un aplat de couleur, pas à un graphique.
              className="pressable group flex h-full max-w-[5rem] flex-1 flex-col justify-end"
              title={`${day.date} — ${Math.round(value)} colis/h`}
            >
              <span className="tabular mb-1 text-center text-[0.6rem] font-bold text-slate-400">
                {Math.round(value)}
              </span>
              <span
                className={`w-full rounded-t ${reached ? 'bg-ok' : 'bg-warn'}`}
                style={{ height: `${height}%` }}
              />
              <span className="mt-1 text-center text-[0.6rem] text-slate-600">
                {day.date.slice(8)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
