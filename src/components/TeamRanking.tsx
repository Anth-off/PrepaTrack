import { MIN_COMPARABLE_SHARE, type OwnerPerformance } from '../core/analysis'
import { formatShort } from '../core/time'

export interface RankedMember extends OwnerPerformance {
  name: string
  badge: string
}

interface Props {
  rows: RankedMember[]
  onSelect?: (ownerId: string) => void
}

/**
 * Classement de l'équipe.
 *
 * Il porte sur l'**écart à ce qu'on attend**, jamais sur la cadence brute :
 * celui qui reçoit les commandes les plus éclatées sortirait sinon systématiquement
 * dernier, sans que son rythme soit en cause. Les deux chiffres sont affichés
 * côte à côte pour que la correction reste visible et discutable.
 */
export function TeamRanking({ rows, onSelect }: Props) {
  if (rows.length === 0) {
    return (
      <div className="card text-sm text-slate-500">
        Pas encore assez de commandes pour comparer. Il faut que le nombre de lignes soit
        renseigné au lancement des commandes.
      </div>
    )
  }

  // Un préparateur seul sur son type de commande sert de référence à lui-même :
  // son écart vaut zéro par construction, pas par performance.
  const comparable = rows.filter((r) => r.comparableShare >= MIN_COMPARABLE_SHARE)
  const isolated = rows.filter((r) => r.comparableShare < MIN_COMPARABLE_SHARE)
  const span = Math.max(10, ...comparable.map((r) => Math.abs(r.delta)))

  return (
    <div className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Écart à la cadence attendue
      </h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        Chaque cadence est corrigée de la densité des commandes reçues. C'est ce qui rend
        la comparaison possible : préparer 100 colis sur 80 références n'est pas préparer
        100 colis sur 10.
      </p>

      {comparable.length === 0 && (
        <p className="rounded-xl bg-ink-700 p-3 text-sm text-slate-400">
          Aucune comparaison possible pour l'instant : chacun travaille sur des types de
          commandes différents, et sert donc de référence à lui-même. Les écarts
          deviendront lisibles quand plusieurs préparateurs auront traité des commandes de
          densité comparable.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {comparable.map((row, index) => {
          const ahead = row.delta >= 0
          const width = Math.min(50, (Math.abs(row.delta) / span) * 50)
          const thin = row.samples < 5

          return (
            <li key={row.ownerId}>
              <button
                type="button"
                onClick={() => onSelect?.(row.ownerId)}
                disabled={!onSelect}
                className="w-full text-left"
              >
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">
                    <span className="tabular mr-1.5 text-slate-600">{index + 1}.</span>
                    {row.name}
                    {thin && (
                      <span
                        className="ml-1.5 rounded bg-ink-700 px-1 text-[0.6rem] font-bold uppercase text-slate-500"
                        title="Peu de commandes : à confirmer"
                      >
                        peu de données
                      </span>
                    )}
                  </span>
                  <span
                    className={`tabular shrink-0 font-bold ${ahead ? 'text-ok' : 'text-bad'}`}
                  >
                    {ahead ? '+' : ''}
                    {Math.round(row.delta)}
                    <span className="ml-1 text-xs font-medium text-slate-500">colis/h</span>
                  </span>
                </div>

                {/* Axe centré : à gauche en dessous de l'attendu, à droite au-dessus. */}
                <div className="relative mt-1 h-2.5 overflow-hidden rounded-full bg-ink-600">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-slate-500" />
                  <div
                    className={`absolute inset-y-0 ${ahead ? 'bg-ok' : 'bg-bad'}`}
                    style={
                      ahead
                        ? { left: '50%', width: `${width}%` }
                        : { right: '50%', width: `${width}%` }
                    }
                  />
                </div>

                <div className="tabular mt-1 flex justify-between text-[0.65rem] text-slate-500">
                  <span>
                    {Math.round(row.observedRate)}/h réalisés · {Math.round(row.expectedRate)}/h
                    attendus
                  </span>
                  <span>
                    {row.colis} colis · {formatShort(row.pickingTime)} · {row.days} vac.
                  </span>
                </div>
              </button>
            </li>
          )
        })}
      </ul>

      {isolated.length > 0 && (
        <div className="mt-4 border-t border-ink-600 pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Hors comparaison
          </h4>
          <p className="mt-1 text-xs text-slate-600">
            Leurs commandes n'ont pas d'équivalent chez les autres : l'écart n'aurait aucun
            sens, ils se compareraient à eux-mêmes.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {isolated.map((row) => (
              <li
                key={row.ownerId}
                className="flex items-baseline justify-between gap-2 text-sm"
              >
                <span className="truncate text-slate-400">{row.name}</span>
                <span className="tabular shrink-0 text-slate-500">
                  {Math.round(row.observedRate)}/h · {row.colis} colis
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
