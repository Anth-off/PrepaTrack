import type { MachineView, Snapshot } from './machine'
import { isInterruption, segmentDef } from './segments'
import { MINUTE } from './time'
import type { Segment, Settings } from './types'

/** Une extinction d'écran ou un changement d'app très bref ne doit pas interrompre le travail. */
export const RESUME_PROMPT_AFTER = MINUTE

export interface ResumeSummary {
  segmentId: string
  segment: Segment
  actionLabel: string
  orderLabel?: string
  resumeLabel?: string
  awayDuration: number
  detectedAt: number
  warning: boolean
  warningAfter: number
}

export function buildResumeSummary({
  snap,
  view,
  settings,
  lastSeenAt,
  now,
}: {
  snap: Snapshot
  view: MachineView
  settings: Settings
  lastSeenAt?: number
  now: number
}): ResumeSummary | undefined {
  const active = view.active
  if (!snap.workday || !active) return undefined
  // Sur une première installation de cette fonctionnalité, aucun heartbeat
  // n'existe encore. La durée du chrono fournit alors une estimation prudente.
  const awayDuration = Math.max(0, now - (lastSeenAt ?? active.startedAt))
  if (awayDuration < RESUME_PROMPT_AFTER) return undefined

  const warningAfter = thresholdFor(active, settings)
  return {
    segmentId: active.id,
    segment: active,
    actionLabel: segmentDef(active.type).label,
    orderLabel: view.order
      ? `${view.order.colisPlanned} colis · ${view.order.linesCount || '?'} ligne${view.order.linesCount > 1 ? 's' : ''} · ${view.order.orderType}`
      : undefined,
    resumeLabel: view.resuming ? segmentDef(view.resuming).label : undefined,
    awayDuration,
    detectedAt: now,
    warning: now - active.startedAt > warningAfter,
    warningAfter,
  }
}

export function thresholdFor(segment: Segment, settings: Settings): number {
  if (segment.type === 'break_10' || segment.type === 'break_30') {
    return settings.stuckThresholds.break * MINUTE
  }
  return (
    isInterruption(segment.type)
      ? settings.stuckThresholds.interruption
      : settings.stuckThresholds.order
  ) * MINUTE
}
