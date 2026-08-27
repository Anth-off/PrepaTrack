import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { buildDiagnosis, COACHING_EVALUATION_MS, delaySignal } from '../core/coaching'
import { dailyProductionStatus } from '../core/productionPlan'
import type { CoachingAlert, VisionObservation } from '../core/types'
import { canRepeatCoachingAlert, coachingAlertsFor, markCoachingAlertRead, saveCoachingAlert } from '../db/coaching'
import { saveSettings } from '../db/db'
import { offlineAI, type OfflineAIStatus } from '../native/offlineAI'
import type { Session } from './useSession'
import { useRecentDays } from './useRecentDays'

export interface OfflineCoachControl {
  status: OfflineAIStatus
  progress?: { downloaded: number; total: number }
  busy: boolean
  error?: string
  current?: CoachingAlert
  alerts: CoachingAlert[]
  download(): Promise<void>
  removeModel(): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
  setVisionEnabled(enabled: boolean): Promise<void>
  setTrainingEnabled(enabled: boolean): Promise<void>
  capture(label: string): Promise<string>
  exportTraining(): Promise<void>
  dismissCurrent(): Promise<void>
}

const EMPTY_STATUS: OfflineAIStatus = { available: false, ready: false, version: '', bytes: 0 }

export function useOfflineCoach(session: Session): OfflineCoachControl {
  const { days } = useRecentDays(365)
  const workdayId = session.snap.workday?.id
  const queriedAlerts = useLiveQuery(
    () => workdayId ? coachingAlertsFor(workdayId) : Promise.resolve([]),
    [workdayId],
  )
  const storedAlerts = useMemo(() => queriedAlerts ?? [], [queriedAlerts])
  const [status, setStatus] = useState<OfflineAIStatus>(EMPTY_STATUS)
  const [progress, setProgress] = useState<{ downloaded: number; total: number }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [vision, setVision] = useState<VisionObservation[]>([])
  const [visibleId, setVisibleId] = useState<string>()
  const persistence = useRef<{ key: string; since: number }>()
  const evaluating = useRef(false)
  const evaluationTick = Math.floor(session.now / COACHING_EVALUATION_MS)
  const analysisNow = Math.max(
    evaluationTick * COACHING_EVALUATION_MS,
    session.events.at(-1)?.at ?? 0,
    session.snap.segments.at(-1)?.updatedAt ?? 0,
  )

  const refresh = useCallback(async () => {
    try { setStatus(await offlineAI.status()) } catch { setStatus(EMPTY_STATUS) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!offlineAI.supported()) return
    let progressListener: Awaited<ReturnType<typeof offlineAI.onDownloadProgress>> | undefined
    let visionListener: Awaited<ReturnType<typeof offlineAI.onVisionObservation>> | undefined
    void offlineAI.onDownloadProgress((event) => setProgress(event)).then((value) => { progressListener = value })
    void offlineAI.onVisionObservation((event) => {
      setVision((current) => [...current.filter((item) => item.at >= Date.now() - 60_000), event])
    }).then((value) => { visionListener = value })
    return () => { void progressListener?.remove(); void visionListener?.remove() }
  }, [])

  useEffect(() => {
    const enabled = Boolean(
      session.settings.ai.enabled && session.settings.ai.visionEnabled && workdayId && status.ready,
    )
    void offlineAI.setVisionEnabled(enabled)
  }, [session.settings.ai.enabled, session.settings.ai.visionEnabled, status.ready, workdayId])

  useEffect(() => {
    if (!session.settings.ai.enabled || !status.ready || !session.snap.workday || evaluating.current) {
      persistence.current = undefined
      return
    }
    const now = analysisNow
    const production = dailyProductionStatus(session.snap.workday.date, session.day.colis, now)
    const context = {
      snap: session.snap,
      events: session.events,
      shortages: session.shortages,
      history: days.filter((day) => day.id !== workdayId),
      production,
      targetRate: session.settings.targetRate,
      now,
      vision,
    }
    const signal = delaySignal(context)
    if (!signal.delayed) { persistence.current = undefined; return }
    const key = `${signal.reason}:${workdayId}`
    if (persistence.current?.key !== key) persistence.current = { key, since: now }
    if (now - persistence.current.since < signal.confirmationMs) return
    const diagnosis = buildDiagnosis(context, signal)
    if (!diagnosis) return
    const previous = storedAlerts.find((alert) => !alert.supersededAt)
    if (!canRepeatCoachingAlert(previous, diagnosis.cause, diagnosis.delayPackages, now)) return
    const alertWorkdayId = session.snap.workday.id

    evaluating.current = true
    setBusy(true)
    setError(undefined)
    void offlineAI.analyze(diagnosis).then(async (copy) => {
      const row = await saveCoachingAlert({
        workdayId: alertWorkdayId,
        orderId: session.view.order?.id,
        at: now,
        cause: diagnosis.cause,
        severity: diagnosis.severity,
        title: copy.title,
        explanation: copy.explanation,
        action: copy.action,
        evidence: diagnosis.evidence,
        confidence: diagnosis.confidence,
        delayPackages: diagnosis.delayPackages,
        modelVersion: copy.modelVersion,
      })
      setVisibleId(row.id)
      window.setTimeout(() => setVisibleId((id) => id === row.id ? undefined : id), 8_000)
      if ('vibrate' in navigator) navigator.vibrate([100, 60, 100])
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Analyse locale indisponible.')
    }).finally(() => {
      evaluating.current = false
      setBusy(false)
    })
  }, [
    analysisNow, days, session.day.colis, session.events,
    session.settings.ai.enabled, session.settings.targetRate, session.shortages, session.snap,
    session.view.order?.id, status.ready, storedAlerts, vision, workdayId,
  ])

  const current = useMemo(
    () => storedAlerts.find((alert) => alert.id === visibleId && !alert.supersededAt),
    [storedAlerts, visibleId],
  )
  const withBusy = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined)
    try { await action(); await refresh() } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Opération impossible.')
    } finally { setBusy(false) }
  }

  return {
    status, progress, busy, error, current,
    alerts: storedAlerts.filter((alert) => !alert.supersededAt),
    download: () => withBusy(async () => { await offlineAI.downloadModel(); setProgress(undefined) }),
    removeModel: () => withBusy(async () => { await offlineAI.deleteModel() }),
    setEnabled: async (enabled) => { await saveSettings({ ai: { enabled } }) },
    setVisionEnabled: async (visionEnabled) => { await saveSettings({ ai: { visionEnabled } }) },
    setTrainingEnabled: async (trainingCollectionEnabled) => {
      await saveSettings({ ai: { trainingCollectionEnabled } })
    },
    capture: async (label) => (await offlineAI.captureTrainingSample(label)).filename,
    exportTraining: () => offlineAI.exportTrainingDataset(),
    dismissCurrent: async () => {
      if (current) await markCoachingAlertRead(current.id)
      setVisibleId(undefined)
    },
  }
}
