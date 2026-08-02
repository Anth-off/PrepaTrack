import { isInterruption, segmentDef } from './segments'
import { MINUTE } from './time'
import type { Segment, Settings } from './types'

export type AlertKind = 'break_end' | 'stuck'

export interface ActiveAlert {
  id: string
  kind: AlertKind
  title: string
  detail: string
}

/**
 * Alertes déduites du seul segment en cours. Aucune minuterie n'est armée : si
 * le téléphone dort une demi-heure, l'alerte apparaît dès le réveil, calculée
 * depuis l'horodatage. Une minuterie, elle, aurait été tuée par iOS.
 */
export function computeAlerts(
  active: Segment | undefined,
  settings: Settings,
  now: number,
): ActiveAlert[] {
  if (!active) return []
  const elapsed = now - active.startedAt
  const alerts: ActiveAlert[] = []

  if (active.type === 'break_10' || active.type === 'break_30') {
    const quota =
      active.type === 'break_10' ? settings.shortBreakMinutes : settings.longBreakMinutes
    if (elapsed > quota * MINUTE) {
      const over = Math.floor((elapsed - quota * MINUTE) / MINUTE)
      alerts.push({
        id: `${active.id}:break_end`,
        kind: 'break_end',
        title: 'Pause terminée',
        detail:
          over < 1
            ? `Les ${quota} minutes sont écoulées.`
            : `${quota} min dépassées de ${over} min.`,
      })
    }
    if (elapsed > settings.stuckThresholds.break * MINUTE) {
      alerts.push(stuckAlert(active, elapsed))
    }
    return alerts
  }

  if (isInterruption(active.type) && elapsed > settings.stuckThresholds.interruption * MINUTE) {
    alerts.push(stuckAlert(active, elapsed))
  } else if (elapsed > settings.stuckThresholds.order * MINUTE) {
    // Vaut aussi pour le briefing, la prépa poste et le rangement : un briefing
    // qui « dure » quatre heures est le symptôme le plus courant d'un bouton
    // oublié, et il fausse toute la journée s'il passe inaperçu.
    alerts.push(stuckAlert(active, elapsed))
  }

  return alerts
}

function stuckAlert(active: Segment, elapsed: number): ActiveAlert {
  return {
    id: `${active.id}:stuck`,
    kind: 'stuck',
    title: 'Chrono resté ouvert ?',
    detail: `« ${segmentDef(active.type).label} » tourne depuis ${Math.floor(
      elapsed / MINUTE,
    )} min. Corrige l'heure si tu as oublié d'appuyer.`,
  }
}
