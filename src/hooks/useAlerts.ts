import { useEffect, useRef } from 'react'
import { computeAlerts, type ActiveAlert } from '../core/alerts'
import type { Segment, Settings } from '../core/types'

/**
 * Émet un bip synthétisé. Pas de fichier audio à précacher, et surtout pas de
 * `navigator.vibrate` : iOS ne l'implémente pas, un retour sonore est le seul
 * signal réellement disponible sur iPhone.
 */
function beep(times = 2) {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = ctx.currentTime + i * 0.35
      osc.frequency.value = 880
      osc.connect(gain)
      gain.connect(ctx.destination)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25)
      osc.start(start)
      osc.stop(start + 0.3)
    }
    window.setTimeout(() => ctx.close(), times * 400 + 300)
  } catch {
    // Le navigateur peut refuser l'audio sans interaction préalable : l'alerte
    // visuelle prend alors le relais, ce n'est pas bloquant.
  }
}

/** Alertes en cours, chacune signalée une seule fois. */
export function useAlerts(
  active: Segment | undefined,
  settings: Settings,
  now: number,
): ActiveAlert[] {
  const alerts = computeAlerts(active, settings, now)
  const signalled = useRef(new Set<string>())

  useEffect(() => {
    for (const alert of alerts) {
      if (signalled.current.has(alert.id)) continue
      signalled.current.add(alert.id)
      if (settings.soundAlerts) beep(alert.kind === 'break_end' ? 2 : 3)
      notify(alert)
    }
    // Les identifiants portent celui du segment : fermer le segment purge
    // naturellement les alertes correspondantes.
  }, [alerts.map((a) => a.id).join('|'), settings.soundAlerts])

  return alerts
}

function notify(alert: ActiveAlert) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    new Notification(alert.title, { body: alert.detail, tag: alert.id })
  } catch {
    // Sur iOS, les notifications ne fonctionnent que pour une PWA installée.
  }
}
