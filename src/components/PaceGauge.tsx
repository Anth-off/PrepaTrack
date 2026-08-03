import type { LiveStatus } from '../core/metrics'
import type { ContextualTarget } from '../core/contextualTarget'
import { hhmm } from '../core/time'
import { TargetReference } from './TargetReference'

interface Props {
  live: LiveStatus
  reference: ContextualTarget
}

/**
 * Avance/retard en direct, exprimé en colis plutôt qu'en minutes : c'est
 * l'unité dans laquelle la cadence est jugée à l'entrepôt.
 */
export function PaceGauge({ live, reference }: Props) {
  const delta = Math.round(live.delta)
  const ahead = delta >= 0
  const tone = live.provisional
    ? 'text-slate-400'
    : delta >= 0
      ? 'text-ok'
      : delta > -15
        ? 'text-warn'
        : 'text-bad'

  const bar = live.provisional
    ? 'bg-slate-500'
    : delta >= 0
      ? 'bg-ok'
      : delta > -15
        ? 'bg-warn'
        : 'bg-bad'

  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Avance / retard
        </span>
        <span className="tabular text-sm text-slate-500">objectif {Math.round(reference.rate)}/h</span>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className={`tabular text-5xl font-bold ${tone}`}>
          {ahead ? '+' : ''}
          {delta}
          <span className="ml-1.5 text-base font-semibold text-slate-500">colis</span>
        </span>
        <span className="tabular text-lg font-bold text-slate-400">
          {/* Sur les tout premiers colis, la cadence extrapolée est absurde
              (un colis en trois secondes donnerait 1200/h) : on ne l'affiche
              qu'une fois l'échantillon suffisant. */}
          {live.provisional || live.currentRate <= 0 ? '—' : `${Math.round(live.currentRate)}/h`}
        </span>
      </div>

      <div className="mt-2 h-3 overflow-hidden rounded-full bg-ink-600">
        <div
          className={`h-full rounded-full transition-all duration-500 ${bar}`}
          style={{ width: `${Math.round(live.progress * 100)}%` }}
        />
      </div>

      <div className="mt-1.5 flex justify-between text-sm text-slate-500">
        <span className="tabular">
          {live.counted} / {live.planned} colis
        </span>
        <span className="tabular">
          {live.remaining === 0
            ? 'objectif atteint'
            : live.estimatedEnd
              ? `fin ~${hhmm(live.estimatedEnd)}`
              : '—'}
        </span>
      </div>

      <TargetReference reference={reference} className="mt-3" />
    </div>
  )
}
