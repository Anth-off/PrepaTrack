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
        <span className="max-w-28 text-right">{ESTIMATED_MISSING_LABEL}</span>
      </div>

      <ul className="mt-2 flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.type} className="flex items-baseline gap-2 text-sm">
            <span className="shrink-0">{line.emoji}</span>
            <span className="flex-1 truncate">
              {line.label}
              <span className="ml-1 text-slate-600">×{line.count}</span>
            </span>
            <span className="tabular shrink-0 font-semibold">{formatShort(line.time)}</span>
            <span className="tabular w-16 shrink-0 text-right text-slate-500">
              ≈ {Math.round(line.colisEquivalent)}
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
