import { BigButton } from './BigButton'
import { Sheet } from './Sheet'
import type { ResumeSummary } from '../core/resume'
import { formatDuration, formatShort, hhmm } from '../core/time'

export function ResumeSheet({
  summary,
  now,
  onContinue,
  onFinish,
  onCorrect,
  onDetails,
}: {
  summary?: ResumeSummary
  now: number
  onContinue: () => void
  onFinish: () => void
  onCorrect: () => void
  onDetails: () => void
}) {
  if (!summary) return null
  const duration = now - summary.segment.startedAt
  const warning = summary.warning || duration > summary.warningAfter

  return (
    <Sheet open title="Reprise du suivi">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <section className="rounded-2xl border border-ink-600 bg-ink-800 p-4 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Action toujours active
          </p>
          <h3 className="mt-1 text-2xl font-bold">{summary.actionLabel}</h3>
          <div className="tabular mt-2 text-5xl font-bold">{formatDuration(duration)}</div>
          <p className="mt-2 text-sm text-slate-400">
            commencée à {hhmm(summary.segment.startedAt)} · absence détectée {formatShort(summary.awayDuration)}
          </p>
          {summary.orderLabel && <p className="mt-2 text-sm text-slate-300">Commande {summary.orderLabel}</p>}
          {summary.resumeLabel && (
            <p className="mt-1 text-sm font-semibold text-info">
              À la fin, reprise de « {summary.resumeLabel} »
            </p>
          )}
        </section>

        {warning && (
          <div role="alert" className="rounded-xl border border-bad/50 bg-bad/10 p-3">
            <p className="font-bold text-bad">Chrono anormalement long</p>
            <p className="mt-1 text-sm text-slate-300">
              Le seuil configuré est de {formatShort(summary.warningAfter)}. Vérifie l’heure avant de continuer.
            </p>
          </div>
        )}

        <BigButton label="Continuer" sub="Ne modifie aucune donnée" tone="ok" onClick={onContinue} />
        <BigButton label="Terminer maintenant" tone="accent" onClick={onFinish} />
        <button
          type="button"
          onClick={onCorrect}
          className="pressable min-h-touch rounded-2xl border border-info/50 bg-info/10 font-bold text-info"
        >
          Corriger l’heure
        </button>
        <button
          type="button"
          onClick={onDetails}
          className="pressable rounded-xl py-3 text-sm font-semibold text-slate-400 underline underline-offset-2"
        >
          Ouvrir le détail de la journée
        </button>
      </div>
    </Sheet>
  )
}
