import { useState } from 'react'
import { calibrationThreshold } from '../core/cartMotion'
import type { Settings } from '../core/types'
import { saveSettings } from '../db/db'
import type { CartMotionControl, CartMotionStatus } from '../hooks/useCartMotion'

export function CartMotionSection({
  settings,
  motion,
}: {
  settings: Settings
  motion: CartMotionControl
}) {
  const [busy, setBusy] = useState<'stationary' | 'moving' | 'permission'>()
  const [message, setMessage] = useState<string>()
  const config = settings.cartMotion

  async function measure(kind: 'stationary' | 'moving') {
    setBusy(kind)
    setMessage(undefined)
    try {
      const energy = await motion.calibrate(kind)
      if (kind === 'stationary') {
        await saveSettings({
          cartMotion: {
            enabled: config.enabled,
            stationaryEnergy: energy,
            movingEnergy: undefined,
            threshold: undefined,
          },
        })
        setMessage('Chariot immobile enregistré. Fais maintenant la mesure en roulant.')
        return
      }

      const stationary = config.stationaryEnergy
      if (stationary === undefined) throw new Error("Mesure d'abord le chariot immobile.")
      const threshold = calibrationThreshold(stationary, energy)
      if (threshold === undefined) {
        throw new Error(
          "Les vibrations roulantes sont trop proches de l'arrêt. Recommence sur un trajet normal.",
        )
      }
      await saveSettings({
        cartMotion: {
          enabled: config.enabled,
          stationaryEnergy: stationary,
          movingEnergy: energy,
          threshold,
        },
      })
      setMessage('Calibration terminée. Tu peux activer la détection automatique.')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Calibration impossible.')
    } finally {
      setBusy(undefined)
    }
  }

  async function toggle() {
    if (config.enabled) {
      if (motion.status === 'permission_needed' || motion.status === 'denied') {
        setBusy('permission')
        await motion.requestPermission()
        setBusy(undefined)
        return
      }
      await saveSettings({ cartMotion: { ...config, enabled: false } })
      return
    }
    if (config.threshold === undefined) {
      setMessage("Effectue d'abord les deux mesures de calibration.")
      return
    }
    setBusy('permission')
    // Le choix d'activation est un réglage durable. On l'enregistre avant la
    // demande iOS afin qu'un rafraîchissement ou la fermeture de la feuille de
    // permission ne remette pas silencieusement l'option à zéro.
    await saveSettings({ cartMotion: { ...config, enabled: true } })
    const granted = await motion.requestPermission()
    if (!granted) {
      setMessage(
        "La détection reste activée. Autorise les capteurs iOS pour la reprendre.",
      )
    }
    setBusy(undefined)
  }

  if (!motion.supported) {
    return (
      <section className="card">
        <Title />
        <p className="mt-1 text-sm text-slate-500">
          Les capteurs de mouvement ne sont pas disponibles sur cet appareil.
        </p>
      </section>
    )
  }

  const calibrated = config.threshold !== undefined
  const calibrating = busy === 'stationary' || busy === 'moving'

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Title />
          <p className="mt-1 text-sm text-slate-500">
            Détecte hors ligne tous les déplacements du chariot pendant la vacation et
            reprend automatiquement l'étape interrompue à l'arrêt. Les mesures des
            capteurs ne quittent jamais l'iPhone.
          </p>
        </div>
        <StatusDot status={motion.status} enabled={config.enabled} />
      </div>

      <div className="mt-4 rounded-xl bg-ink-900 p-3 text-sm">
        <div className="font-semibold">Calibration en deux étapes</div>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-400">
          <li>Laisse le chariot totalement immobile et lance la première mesure.</li>
          <li>
            Pour la seconde, appuie puis roule normalement après le délai d'une seconde.
          </li>
        </ol>
        <p className="mt-2 text-xs text-slate-600">
          Chaque mesure dure environ 9 secondes. Laisse l'iPhone fixé à sa place habituelle.
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void measure('stationary')}
          className="pressable rounded-xl bg-ink-700 px-2 py-3 text-sm font-semibold disabled:opacity-40"
        >
          {busy === 'stationary' ? 'Mesure…' : '1. Chariot immobile'}
        </button>
        <button
          type="button"
          disabled={Boolean(busy) || config.stationaryEnergy === undefined}
          onClick={() => void measure('moving')}
          className="pressable rounded-xl bg-ink-700 px-2 py-3 text-sm font-semibold disabled:opacity-40"
        >
          {busy === 'moving' ? 'Mesure…' : '2. Chariot roulant'}
        </button>
      </div>

      {(message || motion.error) && (
        <p className="mt-2 text-sm text-slate-400">{message ?? motion.error}</p>
      )}

      <button
        type="button"
        disabled={Boolean(busy) || (!calibrated && !config.enabled)}
        onClick={() => void toggle()}
        className={`pressable mt-3 min-h-touch w-full rounded-xl font-bold disabled:opacity-40 ${
          config.enabled ? 'bg-ok text-black' : 'bg-accent text-black'
        }`}
      >
        {busy === 'permission'
          ? 'Autorisation iOS…'
          : config.enabled
            ? motion.status === 'permission_needed' || motion.status === 'denied'
              ? 'Autoriser les capteurs iOS'
              : 'Désactiver la détection automatique'
            : 'Activer la détection automatique'}
      </button>

      {calibrating && (
        <p className="mt-2 animate-pulse text-center text-sm font-semibold text-accent">
          {busy === 'stationary' ? 'Ne touche pas au chariot…' : 'Commence à rouler…'}
        </p>
      )}
    </section>
  )
}

function Title() {
  return (
    <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
      Détection du chariot
    </h3>
  )
}

function StatusDot({
  status,
  enabled,
}: {
  status: CartMotionStatus
  enabled: boolean
}) {
  const moving = status === 'moving'
  let label = 'En écoute'
  if (!enabled) label = 'Arrêtée'
  else if (status === 'permission_needed' || status === 'denied') {
    label = 'Autorisation requise'
  } else if (moving) label = 'En mouvement'
  else if (status === 'stationary') label = 'Immobile'
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-1 text-[0.65rem] font-bold ${
        enabled ? (moving ? 'bg-accent text-black' : 'bg-ok/20 text-ok') : 'bg-ink-700 text-slate-500'
      }`}
    >
      {label}
    </span>
  )
}
