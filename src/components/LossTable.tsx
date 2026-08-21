import type { LossLine } from '../core/analysis'
import { ESTIMATED_MISSING_HELP, ESTIMATED_MISSING_LABEL } from '../core/metricLabels'
import { formatShort } from '../core/time'

interface Props {
  lines: LossLine[]
  dayCount: number
}

/** Temps perdu par cause, converti en colis à la cadence cible. */
export function LossTable({ lines, dayCount }: Props) {
  if (lines.length === 0) return null
  const total = lines.reduce((sum, l) => sum + l.time, 0)
  const totalColis = lines.reduce((sum, l) => sum + l.colisEquivalent, 0)

  return (
    <div className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Où part le temps perdu
      </h3>

      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        <b className="text-slate-400">{ESTIMATED_MISSING_LABEL} :</b>{' '}
        {ESTIMATED_MISSING_HELP}
      </p>

      <div className="mt-3 flex justify-between gap-2 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-600">
        <span>Cause et durée</span>
        <span className="text-right">Colis estimés</span>
      </div>

      <ul className="mt-2 flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.type} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm">
            <span className="row-span-2 shrink-0 pt-0.5">{line.emoji}</span>
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">
                {line.label}
                <span className="ml-1 text-slate-600">×{line.count}</span>
              </span>
              <span className="tabular shrink-0 font-semibold">{formatShort(line.time)}</span>
            </div>
            <span className="tabular text-xs text-slate-500">
              ≈ {Math.round(line.colisEquivalent)} {ESTIMATED_MISSING_LABEL.toLowerCase()}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t border-ink-600 pt-2 text-sm">
        <div className="flex justify-between gap-3 font-bold">
          <span>Total du temps perdu</span>
          <span className="tabular">{formatShort(total)}</span>
        </div>
        <div className="mt-1 flex justify-between gap-3 font-bold">
          <span>{ESTIMATED_MISSING_LABEL}</span>
          <span className="tabular">≈ {Math.round(totalColis)}</span>
        </div>
        {dayCount > 1 && (
          <div className="tabular mt-0.5 text-xs text-slate-500">
            Par vacation : {formatShort(total / dayCount)} · ≈{' '}
            {Math.round(totalColis / dayCount)} {ESTIMATED_MISSING_LABEL.toLowerCase()}
          </div>
        )}
      </div>
    </div>
  )
}
