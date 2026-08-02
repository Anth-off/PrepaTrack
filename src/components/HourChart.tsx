import type { HourPoint } from '../core/analysis'
import { formatShort } from '../core/time'

interface Props {
  points: HourPoint[]
  targetRate: number
}

/** Cadence heure par heure : sert à repérer un décrochage en fin de vacation. */
export function HourChart({ points, targetRate }: Props) {
  const max = Math.max(targetRate, ...points.map((p) => p.rate), 1)

  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Cadence heure par heure
        </h3>
        <span className="tabular text-xs text-slate-500">objectif {targetRate}/h</span>
      </div>

      {points.length < 2 ? (
        <p className="mt-3 text-sm text-slate-600">
          Il faut au moins deux heures de préparation enregistrées.
        </p>
      ) : (
        <>
          <div className="relative mt-4 flex h-36 items-end gap-1">
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-500/60"
              style={{ bottom: `${(targetRate / max) * 100}%` }}
            />
            {points.map((point) => {
              const reached = point.rate >= targetRate
              return (
                <div
                  key={point.hour}
                  className="flex h-full max-w-[4rem] flex-1 flex-col justify-end"
                  title={`${point.hour} h — ${Math.round(point.rate)} colis/h sur ${formatShort(point.pickingTime)} de prépa`}
                >
                  <span className="tabular mb-1 text-center text-[0.6rem] font-bold text-slate-400">
                    {Math.round(point.rate)}
                  </span>
                  <span
                    className={`w-full rounded-t ${reached ? 'bg-ok' : 'bg-warn'}`}
                    style={{ height: `${Math.max(2, (point.rate / max) * 100)}%` }}
                  />
                  <span className="mt-1 text-center text-[0.6rem] text-slate-600">
                    {point.hour}h
                  </span>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-slate-600">
            Calculé sur le temps de prélèvement seul : trajets, aléas et pauses n'y entrent
            pas.
          </p>
        </>
      )}
    </div>
  )
}
