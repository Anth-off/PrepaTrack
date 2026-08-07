import { useEffect, useRef } from 'react'
import type { Phase } from '../core/machine'
import { endLiveActivity, startLiveActivity, updateLiveActivity } from '../native/liveActivity'
import type { RecordingStatus } from './useRecording'
import type { Session } from './useSession'

const LABELS: Record<Phase, string> = {
  no_day: 'Journée', briefing: 'Briefing', poste_prep: 'Préparation du poste',
  ready: 'Prêt', order_setup: 'Début de commande', picking: 'Préparation',
  wrapping: 'Filmage', docking: 'Dépose', cleanup: 'Fin de journée',
  interrupted: 'Interruption',
}

/** Met à jour ActivityKit uniquement lorsque l'état métier change, pas chaque seconde. */
export function useLiveActivity(session: Session, recordingStatus: RecordingStatus): void {
  const activeDay = useRef<string>()
  const workday = session.snap.workday
  const phaseStartedAt = session.view.active?.startedAt ?? workday?.startedAt ?? session.now
  const packages = session.live?.counted ?? session.day.colis
  const plannedPackages = session.view.order?.colisPlanned ?? 0
  const phase = LABELS[session.view.phase]
  const detail = session.view.order
    ? `Commande ${session.view.order.colisPlanned} colis`
    : `${session.day.ordersCount} commande${session.day.ordersCount > 1 ? 's' : ''}`
  const recording = recordingStatus === 'recording'

  useEffect(() => {
    if (!workday || workday.status !== 'open') {
      if (activeDay.current) void endLiveActivity().catch(() => undefined)
      activeDay.current = undefined
      return
    }
    const state = { phase, detail, packages, plannedPackages, recording, phaseStartedAt }
    if (activeDay.current !== workday.id) {
      activeDay.current = workday.id
      void startLiveActivity({
        ...state,
        workdayId: workday.id,
        workdayStartedAt: workday.startedAt,
      }).catch(() => { activeDay.current = undefined })
    } else {
      void updateLiveActivity(state).catch(() => undefined)
    }
  }, [detail, packages, phase, phaseStartedAt, plannedPackages, recording, workday])
}
