import type { ContextualTarget } from '../core/contextualTarget'

export function TargetReference({
  reference,
  className = '',
}: {
  reference: ContextualTarget
  className?: string
}) {
  return (
    <div className={`rounded-xl bg-ink-700 px-3 py-2 text-sm ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-slate-300">Objectif retenu</span>
        <span className="tabular shrink-0 font-bold text-accent">
          {Math.round(reference.rate)}/h
        </span>
      </div>
      <p className="mt-0.5 text-xs text-slate-400">{reference.context}</p>
      <p className="mt-1 text-xs text-slate-500">
        {reference.explanation} · Source :{' '}
        {reference.source === 'personal-history' ? 'historique personnel local' : 'réglage manuel'}
        {reference.method === 'median' ? ' · méthode : médiane' : ''}
      </p>
    </div>
  )
}
