import { useState } from 'react'
import type { IntegrityIssue, IntegritySeverity } from '../core/integrity'

const LEVEL: Record<IntegritySeverity, { label: string; tone: string }> = {
  blocking: { label: 'Bloquant', tone: 'border-bad/60 bg-bad/10 text-bad' },
  check: { label: 'À vérifier', tone: 'border-warn/60 bg-warn/10 text-warn' },
  information: { label: 'Information', tone: 'border-info/60 bg-info/10 text-info' },
}

export function IntegrityPanel({
  issues,
  onOpen,
  onDismiss,
}: {
  issues: IntegrityIssue[]
  onOpen: (issue: IntegrityIssue) => void
  onDismiss: (issue: IntegrityIssue) => Promise<void>
}) {
  const [confirming, setConfirming] = useState<string>()
  if (issues.length === 0) return null

  return (
    <section className="rounded-2xl border border-warn/40 bg-ink-800 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Contrôles des données
        </h3>
        <span className="text-xs font-bold text-warn">{issues.length} à examiner</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Aucun chiffre n’est corrigé automatiquement.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {issues.map((item) => {
          const level = LEVEL[item.severity]
          return (
            <article key={item.id} className={`rounded-xl border p-3 ${level.tone}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[0.65rem] font-bold uppercase tracking-wide">
                    {level.label}
                  </span>
                  <h4 className="font-bold text-slate-100">{item.title}</h4>
                </div>
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  className="pressable shrink-0 rounded-lg bg-ink-700 px-2.5 py-1.5 text-xs font-bold text-slate-200"
                >
                  Corriger ›
                </button>
              </div>
              <p className="mt-1 text-sm text-slate-300">{item.detail}</p>
              <p className="mt-1 text-xs text-slate-500">{item.correction}</p>
              {confirming === item.id ? (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(undefined)}
                    className="pressable rounded-lg bg-ink-700 px-2.5 py-1.5 text-xs font-semibold text-slate-300"
                  >
                    Annuler
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDismiss(item)}
                    className="pressable rounded-lg bg-slate-500 px-2.5 py-1.5 text-xs font-bold text-black"
                  >
                    Confirmer le faux positif
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(item.id)}
                  className="pressable mt-2 text-xs font-semibold text-slate-500 underline underline-offset-2"
                >
                  C’est normal, ne plus répéter
                </button>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
