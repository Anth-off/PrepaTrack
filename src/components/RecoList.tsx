import type { Recommendation } from '../core/recommendations'

interface Props {
  recommendations: Recommendation[]
  dayCount: number
}

const TONES: Record<Recommendation['severity'], string> = {
  high: 'border-bad/50 bg-bad/10',
  medium: 'border-warn/50 bg-warn/10',
  info: 'border-ink-600 bg-ink-800',
}

/** Constats chiffrés issus des règles d'analyse, du plus coûteux au moins. */
export function RecoList({ recommendations, dayCount }: Props) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Ce que disent les chiffres
        </h3>
        <span className="text-xs text-slate-600">
          sur {dayCount} vacation{dayCount > 1 ? 's' : ''}
        </span>
      </div>

      {recommendations.length === 0 ? (
        <p className="card text-sm text-slate-500">
          Rien à signaler pour l'instant. Les constats apparaissent au fil des vacations
          enregistrées.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {recommendations.map((reco) => (
            <li key={reco.id} className={`rounded-2xl border p-4 ${TONES[reco.severity]}`}>
              <div className="flex items-start justify-between gap-2">
                <h4 className="font-bold leading-tight">{reco.title}</h4>
                {reco.confidence === 'indicatif' && (
                  <span
                    className="shrink-0 rounded-md bg-ink-700 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase text-slate-400"
                    title="Échantillon encore réduit : à confirmer sur plus de vacations"
                  >
                    indicatif
                  </span>
                )}
              </div>
              <p className="tabular mt-1 text-sm text-slate-300">{reco.detail}</p>
              <p className="mt-2 text-sm text-slate-400">{reco.action}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
