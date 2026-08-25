import type { LiveStatus } from '../core/metrics'
import type { ContextualTarget } from '../core/contextualTarget'
import type { DailyProductionStatus } from '../core/productionPlan'
import { hhmm } from '../core/time'
import { TargetReference } from './TargetReference'

interface Props {
  live: LiveStatus
  reference: ContextualTarget
  compact?: boolean
  daily?: DailyProductionStatus
}

/**
 * Avance/retard en direct, exprimé en colis plutôt qu'en minutes : c'est
 * l'unité dans laquelle la cadence est jugée à l'entrepôt.
 */
export function PaceGauge({ live, reference, compact = false, daily }: Props) {
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
    <div className={compact ? 'card p-2.5' : 'card'}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Avance / retard
        </span>
        <span className="tabular text-sm text-slate-500">objectif {Math.round(reference.rate)}/h</span>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className={`tabular font-bold ${compact ? 'text-4xl' : 'text-5xl'} ${tone}`}>
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

      <div
        className={`${compact ? 'mt-1 h-2' : 'mt-2 h-3'} overflow-hidden rounded-full bg-ink-600`}
      >
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

      {daily && (
        <div className="mt-1.5 border-t border-ink-600 pt-1.5 text-xs text-slate-400">
          <div className="flex items-center justify-between gap-2">
            <span className="tabular font-semibold text-slate-300">
              Journée {daily.actual}/{daily.target}
            </span>
            <span
              className={`tabular font-semibold ${
                daily.delta >= 0 ? 'text-ok' : daily.delta > -15 ? 'text-warn' : 'text-bad'
              }`}
            >
              attendu {Math.round(daily.expected)} · {daily.delta >= 0 ? '+' : ''}
              {Math.round(daily.delta)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-slate-500">
            <span>
              {daily.nextCheckpoint
                ? `${daily.nextCheckpoint.target} à ${hhmm(daily.nextCheckpoint.at)}`
                : 'Commandes terminées'}
            </span>
            <span className="tabular">
              {daily.requiredRate === undefined
                ? 'objectif hors délai'
                : daily.actual >= daily.target
                  ? 'objectif atteint'
                  : `besoin ${Math.round(daily.requiredRate)}/h`}
            </span>
          </div>
        </div>
      )}

      {!compact && <TargetReference reference={reference} className="mt-3" />}
    </div>
  )
}
