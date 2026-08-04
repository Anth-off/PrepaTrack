import { useEffect, useState } from 'react'
import type { AppUpdateControl } from '../hooks/useAppUpdate'

export function AppUpdateNotice({ update }: { update: AppUpdateControl }) {
  const [confirming, setConfirming] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    setConfirming(false)
    setDismissed(false)

    if (update.notice !== 'deferred') return
    const timeout = window.setTimeout(() => setDismissed(true), 8_000)
    return () => window.clearTimeout(timeout)
  }, [update.notice])

  if (update.notice === 'hidden' || dismissed) return null

  if (update.notice === 'deferred') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed left-1/2 z-50 -translate-x-1/2 rounded-full border border-accent/40 bg-ink-800/95 px-3 py-1.5 text-center text-xs font-semibold text-slate-200 shadow-lg"
        style={{ top: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
      >
        Mise à jour prête — installation après la journée
      </div>
    )
  }

  return (
    <section
      role="dialog"
      aria-label="Mise à jour de PrepaTrack"
      className="fixed inset-x-4 z-50 mx-auto max-w-md rounded-2xl border border-accent/50 bg-ink-800 p-4 shadow-2xl"
      style={{ top: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
    >
      <div className="font-bold text-slate-100">Mise à jour prête</div>
      <p className="mt-1 text-sm text-slate-400">
        {confirming
          ? "L'application va redémarrer. Tes données locales sont déjà enregistrées."
          : `PrepaTrack ${update.available ? `v${update.available.version}` : 'nouvelle version'} est téléchargée.`}
      </p>

      {confirming ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="pressable min-h-touch rounded-xl bg-ink-700 px-3 font-semibold text-slate-300"
          >
            Annuler
          </button>
          <button
            type="button"
            disabled={!update.activationAllowed || update.installing}
            onClick={() => void update.install()}
            className="pressable min-h-touch rounded-xl bg-accent px-3 font-bold text-black disabled:opacity-50"
          >
            {update.installing ? 'Installation…' : 'Confirmer'}
          </button>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="pressable min-h-touch rounded-xl bg-ink-700 px-3 font-semibold text-slate-300"
          >
            Plus tard
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="pressable min-h-touch rounded-xl bg-accent px-3 font-bold text-black"
          >
            Mettre à jour
          </button>
        </div>
      )}
    </section>
  )
}
