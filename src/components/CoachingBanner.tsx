import type { CoachingAlert } from '../core/types'

export function CoachingBanner({ alert, onOpen }: { alert: CoachingAlert; onOpen: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-3 top-2 z-50 flex justify-center">
      <button
        type="button"
        onClick={onOpen}
        className="pressable pointer-events-auto w-full max-w-xl rounded-2xl border border-accent/50 bg-ink-800/95 px-4 py-3 text-left shadow-2xl backdrop-blur"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-accent">Coach hors ligne</div>
            <div className="mt-0.5 font-bold text-slate-100">{alert.title}</div>
          </div>
          <span className="tabular rounded-full bg-bad/15 px-2 py-1 text-xs font-bold text-bad">
            −{alert.delayPackages}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-slate-300">{alert.action}</p>
      </button>
    </div>
  )
}
