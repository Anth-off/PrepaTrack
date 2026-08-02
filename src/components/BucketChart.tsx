import type { Bucket } from '../core/analysis'

interface Props {
  title: string
  buckets: Bucket[]
  targetRate: number
  /** Affiché quand il n'y a pas encore de quoi comparer. */
  empty?: string
  unit?: string
}

/**
 * Barres horizontales comparatives. Chaque ligne affiche le nombre
 * d'observations : un chiffre issu d'une seule commande ne doit pas se lire
 * comme une tendance.
 */
export function BucketChart({ title, buckets, targetRate, empty, unit = 'colis/h' }: Props) {
  const max = Math.max(targetRate, ...buckets.map((b) => b.rate), 1)

  return (
    <div className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h3>

      {buckets.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">
          {empty ?? 'Pas encore assez de données.'}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {buckets.map((bucket) => {
            const reached = bucket.rate >= targetRate
            return (
              <li key={bucket.key}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">{bucket.label}</span>
                  <span className="tabular shrink-0 font-bold">
                    {Math.round(bucket.rate)}
                    <span className="ml-1 text-xs font-medium text-slate-500">{unit}</span>
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-ink-600">
                    <div
                      className={`h-full rounded-full ${reached ? 'bg-ok' : 'bg-warn'}`}
                      style={{ width: `${Math.min(100, (bucket.rate / max) * 100)}%` }}
                    />
                    {/* Repère de l'objectif, pour situer chaque barre. */}
                    <div
                      className="absolute inset-y-0 w-px bg-slate-300/70"
                      style={{ left: `${Math.min(100, (targetRate / max) * 100)}%` }}
                    />
                  </div>
                  <span className="tabular w-16 shrink-0 text-right text-[0.65rem] text-slate-600">
                    {bucket.samples} obs.
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
