import { useLiveQuery } from 'dexie-react-hooks'
import { hhmm } from '../core/time'
import { coachingAlertsFor } from '../db/coaching'

export function CoachingHistory({ workdayId }: { workdayId: string }) {
  const alerts = useLiveQuery(() => coachingAlertsFor(workdayId), [workdayId]) ?? []
  const visible = alerts.filter((alert) => !alert.supersededAt)
  if (visible.length === 0) return null
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Coach hors ligne
      </h3>
      <div className="flex flex-col gap-2">
        {visible.map((alert) => (
          <article key={alert.id} className="card">
            <div className="flex items-baseline justify-between gap-3">
              <strong>{alert.title}</strong>
              <span className="tabular shrink-0 text-xs text-slate-500">{hhmm(alert.at)}</span>
            </div>
            <p className="mt-1 text-sm text-slate-300">{alert.explanation}</p>
            <p className="mt-2 rounded-lg bg-accent/10 px-3 py-2 text-sm font-semibold text-accent">
              {alert.action}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {alert.evidence.map((item) => (
                <span key={item.code} className="rounded-md bg-ink-700 px-2 py-1 text-xs text-slate-400">
                  {item.label} : {item.value} {item.unit}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
