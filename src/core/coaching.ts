import type { DayData } from './analysis'
import type { Snapshot } from './machine'
import { categoryOf, segmentDef } from './segments'
import { HOUR, MINUTE } from './time'
import type {
  CoachingCause,
  CoachingEvidence,
  ColisEvent,
  Segment,
  StockShortage,
  VisionObservation,
} from './types'
import type { DailyProductionStatus } from './productionPlan'
import { computeLive } from './metrics'

export const COACHING_EVALUATION_MS = 30_000
export const DAILY_DELAY_PACKAGES = 15
export const DAILY_CONFIRM_MS = 5 * MINUTE
export const ORDER_DELAY_PACKAGES = 10
export const ORDER_CONFIRM_MS = 3 * MINUTE
export const PROJECTED_DELAY_PACKAGES = 20
export const COACHING_COOLDOWN_MS = 15 * MINUTE
export const COACHING_REPEAT_WORSENING = 15
export const MIN_COMPARABLE_ORDERS = 3
export const MIN_COMPARABLE_EVENTS = 30

export interface DelaySignal {
  delayed: boolean
  packages: number
  reason: 'daily' | 'order' | 'checkpoint' | 'none'
  confirmationMs: number
}

export interface CoachingDiagnosis {
  cause: CoachingCause
  severity: 'medium' | 'high'
  title: string
  explanation: string
  action: string
  evidence: CoachingEvidence[]
  confidence: number
  delayPackages: number
}

export interface CoachingContext {
  snap: Snapshot
  events: ColisEvent[]
  shortages: StockShortage[]
  history: DayData[]
  production?: DailyProductionStatus
  targetRate: number
  now: number
  vision?: VisionObservation[]
}

export function delaySignal(ctx: CoachingContext): DelaySignal {
  const order = ctx.snap.orders.find((item) => item.status === 'open' && !item.deletedAt)
  const orderLive = order
    ? computeLive(order, ctx.snap.segments, ctx.events, ctx.targetRate, ctx.now)
    : undefined
  const dailyGap = Math.max(0, -(ctx.production?.delta ?? 0))
  const orderGap = Math.max(0, -(orderLive?.delta ?? 0))
  const checkpointGap = projectedCheckpointGap(ctx.production, ctx.now)

  if (checkpointGap >= PROJECTED_DELAY_PACKAGES) {
    return { delayed: true, packages: checkpointGap, reason: 'checkpoint', confirmationMs: 0 }
  }
  if (dailyGap >= DAILY_DELAY_PACKAGES) {
    return { delayed: true, packages: dailyGap, reason: 'daily', confirmationMs: DAILY_CONFIRM_MS }
  }
  if (orderGap >= ORDER_DELAY_PACKAGES) {
    return { delayed: true, packages: orderGap, reason: 'order', confirmationMs: ORDER_CONFIRM_MS }
  }
  return { delayed: false, packages: Math.max(dailyGap, orderGap), reason: 'none', confirmationMs: 0 }
}

function projectedCheckpointGap(production: DailyProductionStatus | undefined, now: number): number {
  const next = production?.nextCheckpoint
  if (!production || !next || next.at <= now || production.requiredRate === undefined) return 0
  const remainingHours = (next.at - now) / HOUR
  // Projection conservatrice au rythme opérationnel déjà calculé par l'app.
  const projected = production.actual + remainingHours * production.operationalTargetRate
  return Math.max(0, Math.round(next.target - projected))
}

export function buildDiagnosis(ctx: CoachingContext, signal: DelaySignal): CoachingDiagnosis | undefined {
  if (!signal.delayed || isRegulatoryBreak(ctx.snap.segments, ctx.now)) return undefined
  const windowStart = ctx.now - 15 * MINUTE
  const recent = ctx.snap.segments.filter(
    (segment) => !segment.deletedAt && (segment.endedAt ?? ctx.now) >= windowStart,
  )
  const candidates: Candidate[] = []

  const active = recent.find((segment) => segment.endedAt === undefined)
  if (active && (active.type.startsWith('incident_') || active.type.startsWith('custom_'))) {
    const minutes = overlapMs(active, windowStart, ctx.now) / MINUTE
    candidates.push(candidate(
      'incident', minutes * ctx.targetRate / 60, 0.98,
      `${segmentDef(active.type).emoji} ${segmentDef(active.type).short}`,
      `${round1(minutes)} min d’aléa en cours`,
      'Conserve ce motif actif jusqu’à la reprise : ce retard est subi et restera chiffré dans le bilan.',
      evidence('incident_minutes', segmentDef(active.type).short, minutes, 'minutes', 1),
    ))
  }

  addSegmentCandidate(candidates, recent, 'travel', 'travel', ctx, windowStart,
    '🚜 Les trajets pèsent sur le rythme',
    'Regroupe les prochains déplacements si la disposition de la commande le permet.')
  addSegmentCandidate(candidates, recent, 'idle', 'idle', ctx, windowStart,
    '⏸️ Attente entre deux étapes',
    'Prépare l’étape ou la commande suivante avant la fin de celle en cours si c’est possible.')
  addSegmentCandidate(candidates, recent, 'order_setup', 'setup', ctx, windowStart,
    '🏷️ La préparation initiale prend du temps',
    'Rassemble palette, support et étiquette avant de lancer la prochaine commande.')
  addSegmentCandidate(candidates, recent, 'wrapping', 'wrapping', ctx, windowStart,
    '🎞️ Le filmage ralentit la progression',
    'Vérifie si le film et le support peuvent être positionnés avant la fin du picking.')
  addSegmentCandidate(candidates, recent, 'docking', 'docking', ctx, windowStart,
    '📍 La mise à quai prend du temps',
    'Anticipe l’emplacement de dépôt avant de quitter la zone de picking.')
  addSegmentCandidate(candidates, recent, 'pallet_change', 'pallet', ctx, windowStart,
    '🪵 Les changements de palette s’accumulent',
    'Choisis si possible un support adapté au volume dès le début de la prochaine commande.')

  const currentOrder = ctx.snap.orders.find((order) => order.status === 'open' && !order.deletedAt)
  if (currentOrder) {
    const currentGaps = pickingGaps(currentOrder.id, ctx.events, ctx.snap.segments)
      .filter((gap) => gap.at >= windowStart)
    const baseline = comparablePickingBaseline(currentOrder.id, currentOrder.orderType,
      currentOrder.colisPlanned, currentOrder.linesCount, currentOrder.supports,
      currentOrder.startedAt, ctx.history)
    if (baseline && currentGaps.length >= 3) {
      const currentSeconds = median(currentGaps.map((gap) => gap.msPerPackage)) / 1_000
      const excessSeconds = currentSeconds - baseline.secondsPerPackage
      if (excessSeconds >= Math.max(1.5, baseline.secondsPerPackage * 0.25)) {
        const affected = currentGaps.reduce((sum, gap) => sum + gap.delta, 0)
        const lostPackages = Math.max(1, (excessSeconds * affected / 3600) * ctx.targetRate)
        candidates.push(candidate(
          'picking_gap', lostPackages, 0.88,
          '⏱️ Les intervalles de picking se sont allongés',
          `${round1(currentSeconds)} s/colis récemment contre ${round1(baseline.secondsPerPackage)} s sur ${baseline.orders} commandes comparables`,
          'Sur les prochains prélèvements, rapproche le chariot et groupe les références voisines.',
          evidence('current_gap', 'Intervalle récent', currentSeconds, 'seconds', 0.95),
          evidence('baseline_gap', 'Référence personnelle', baseline.secondsPerPackage, 'seconds', 0.9),
        ))
      }
    }

    const density = currentOrder.linesCount > 0
      ? currentOrder.colisPlanned / currentOrder.linesCount
      : undefined
    if (density !== undefined && density < 1.5) {
      candidates.push(candidate(
        'density', Math.min(signal.packages, 6), 0.82,
        '🧩 La commande est très éclatée',
        `${round1(density)} colis par ligne : ce format demande mécaniquement davantage d’arrêts`,
        'Ne force pas une cadence irréaliste : limite surtout les retours et parcours la zone dans un seul sens.',
        evidence('density', 'Densité de commande', density, 'count', 1),
      ))
    }

    const shortage = ctx.shortages
      .filter((item) => item.orderId === currentOrder.id && !item.deletedAt)
      .reduce((sum, item) => sum + item.quantity, 0)
    if (shortage > 0) {
      candidates.push(candidate(
        'shortage', shortage, 0.98,
        '📦 Des colis sont hors stock',
        `${shortage} colis signalé${shortage > 1 ? 's' : ''} indisponible${shortage > 1 ? 's' : ''}`,
        'Poursuis la commande sans attendre ces colis : la rupture restera séparée de ta cadence.',
        evidence('shortage', 'Colis hors stock', shortage, 'colis', 1),
      ))
    }
  }

  const visual = (ctx.vision ?? [])
    .filter((item) => item.at >= ctx.now - 30_000)
    .sort((a, b) => b.confidence - a.confidence)[0]
  if (visual && visual.confidence >= 0.7) {
    const label = visual.kind === 'congestion' ? 'Plusieurs personnes dans l’axe' : 'Passage possiblement encombré'
    candidates.push(candidate(
      'visual_obstruction', Math.min(signal.packages, 8), Math.min(0.85, visual.confidence),
      '👥 Passage possiblement encombré',
      `${label} pendant ${Math.round(visual.durationMs / 1_000)} s ; c’est une hypothèse visuelle locale`,
      'Attends l’ouverture du passage ou prends une allée parallèle si elle est disponible.',
      evidence('vision', label, visual.durationMs / 1_000, 'seconds', visual.confidence),
    ))
  }

  const best = candidates
    .filter((item) => item.impact >= 2)
    .sort((a, b) => b.score - a.score)[0]
  if (!best) return undefined
  return {
    cause: best.cause,
    severity: signal.packages >= 30 ? 'high' : 'medium',
    title: best.title,
    explanation: `${controllability(best.cause)}. ${best.detail}. Retard confirmé : ${Math.round(signal.packages)} colis.`,
    action: best.action,
    evidence: best.evidence,
    confidence: best.confidence,
    delayPackages: Math.round(signal.packages),
  }
}

interface Candidate {
  cause: CoachingCause
  impact: number
  score: number
  confidence: number
  title: string
  detail: string
  action: string
  evidence: CoachingEvidence[]
}

function candidate(
  cause: CoachingCause,
  impact: number,
  confidence: number,
  title: string,
  detail: string,
  action: string,
  ...facts: CoachingEvidence[]
): Candidate {
  return { cause, impact, confidence, score: impact * confidence, title, detail, action, evidence: facts }
}

function addSegmentCandidate(
  out: Candidate[], recent: Segment[], type: string, cause: CoachingCause,
  ctx: CoachingContext, from: number, title: string, action: string,
) {
  const matching = recent.filter((segment) => segment.type === type)
  const ms = matching.reduce((sum, segment) => sum + overlapMs(segment, from, ctx.now), 0)
  if (ms < 2 * MINUTE) return
  const minutes = ms / MINUTE
  const impact = minutes * ctx.targetRate / 60
  out.push(candidate(
    cause, impact, 0.94, title,
    `${round1(minutes)} min sur les 15 dernières minutes, soit environ ${Math.round(impact)} colis`,
    action,
    evidence(`${type}_minutes`, segmentDef(type).short, minutes, 'minutes', 1),
  ))
}

function evidence(
  code: string, label: string, value: number, unit: CoachingEvidence['unit'], confidence: number,
): CoachingEvidence {
  return { code, label, value: round1(value), unit, confidence }
}

function overlapMs(segment: Segment, from: number, to: number): number {
  return Math.max(0, Math.min(segment.endedAt ?? to, to) - Math.max(segment.startedAt, from))
}

function isRegulatoryBreak(segments: Segment[], now: number): boolean {
  const active = segments.find((segment) => !segment.deletedAt && segment.endedAt === undefined)
  return Boolean(active && categoryOf(active.type) === 'break' && active.startedAt <= now)
}

export interface PickingGap {
  at: number
  delta: number
  activeMs: number
  msPerPackage: number
}

/** Intervalles entre comptages, limités aux seules portions réellement en picking. */
export function pickingGaps(orderId: string, events: ColisEvent[], segments: Segment[]): PickingGap[] {
  const ownEvents = events
    .filter((event) => event.orderId === orderId && event.delta > 0 && !event.deletedAt)
    .sort((a, b) => a.at - b.at)
  const picking = segments.filter(
    (segment) => segment.orderId === orderId && segment.type === 'picking' && !segment.deletedAt,
  )
  const gaps: PickingGap[] = []
  for (let index = 1; index < ownEvents.length; index += 1) {
    const previous = ownEvents[index - 1]
    const current = ownEvents[index]
    const activeMs = picking.reduce(
      (sum, segment) => sum + overlapMs(segment, previous.at, current.at), 0,
    )
    if (activeMs <= 0) continue
    gaps.push({ at: current.at, delta: current.delta, activeMs, msPerPackage: activeMs / current.delta })
  }
  return gaps
}

interface Baseline { secondsPerPackage: number; orders: number; events: number }

function comparablePickingBaseline(
  currentOrderId: string,
  orderType: string,
  colis: number,
  lines: number,
  supports: Record<string, number>,
  startedAt: number,
  history: DayData[],
): Baseline | undefined {
  const density = lines > 0 ? colis / lines : undefined
  const values: number[] = []
  let orders = 0
  for (const day of history) {
    for (const metrics of day.metrics.orders) {
      const order = metrics.order
      if (order.id === currentOrderId || order.orderType !== orderType || order.linesCount <= 0) continue
      const candidateDensity = metrics.colis / order.linesCount
      if (density !== undefined && densityBucket(candidateDensity) !== densityBucket(density)) continue
      if (supportSignature(order.supports) !== supportSignature(supports)) continue
      if (timeBucket(order.startedAt) !== timeBucket(startedAt)) continue
      const gaps = pickingGaps(order.id, day.events, day.segments)
      if (gaps.length === 0) continue
      orders += 1
      values.push(...gaps.map((gap) => gap.msPerPackage))
    }
  }
  if (orders < MIN_COMPARABLE_ORDERS || values.length < MIN_COMPARABLE_EVENTS) return undefined
  return { secondsPerPackage: median(values) / 1_000, orders, events: values.length }
}

function supportSignature(supports: Record<string, number>): string {
  return Object.entries(supports).filter(([, count]) => count > 0).map(([kind]) => kind).sort().join('|')
}

function timeBucket(at: number): number {
  const hour = new Date(at).getHours()
  return hour < 15 ? 0 : hour < 17 ? 1 : hour < 19 ? 2 : 3
}

function controllability(cause: CoachingCause): string {
  return ['incident', 'shortage', 'density', 'visual_obstruction'].includes(cause)
    ? 'Facteur principalement subi'
    : 'Facteur améliorable'
}

function densityBucket(value: number): number {
  if (value < 1.5) return 0
  if (value < 3) return 1
  if (value < 6) return 2
  return 3
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
