import { useEffect, useMemo, useRef } from 'react'
import { computeAlerts, type ActiveAlert } from '../core/alerts'
import { playAppBeep } from '../core/audioFeedback'
import type { Segment, Settings } from '../core/types'

/** Alertes en cours, chacune signalée une seule fois. */
export function useAlerts(
  active: Segment | undefined,
  settings: Settings,
  now: number,
): ActiveAlert[] {
  const alerts = useMemo(() => computeAlerts(active, settings, now), [active, settings, now])
  const signalled = useRef(new Set<string>())

  useEffect(() => {
    for (const alert of alerts) {
      if (signalled.current.has(alert.id)) continue
      signalled.current.add(alert.id)
      if (settings.soundAlerts) {
        playAppBeep({
          frequency: 880,
          times: alert.kind === 'break_end' ? 2 : 3,
          peakGain: 0.3,
        })
      }
      notify(alert)
    }
    // Les identifiants portent celui du segment : fermer le segment purge
    // naturellement les alertes correspondantes.
  }, [alerts, settings.soundAlerts])

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
