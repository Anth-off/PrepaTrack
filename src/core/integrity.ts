import type { Snapshot } from './machine'
import { computeOrderMetrics, MIN_RATE_WINDOW, orderColis } from './metrics'
import { isInterruption, segmentDef } from './segments'
import { dayKey, MINUTE } from './time'
import type { ColisEvent, Order, Segment, Settings, StockShortage } from './types'

export type IntegritySeverity = 'information' | 'check' | 'blocking'
export type IntegrityEntity = 'workday' | 'order' | 'segment' | 'shortage'

export type IntegrityRule =
  | 'stuck_timer'
  | 'stale_workday'
  | 'unexplained_count'
  | 'missing_order_phase'
  | 'negative_supports'
  | 'invalid_timeline'
  | 'impossible_rate'
  | 'probable_duplicate'
  | 'shortage_mismatch'

export interface IntegrityIssue {
  id: string
  fingerprint: string
  rule: IntegrityRule
  severity: IntegritySeverity
  entity: IntegrityEntity
  entityId: string
  title: string
  detail: string
  correction: string
}

export interface IntegrityInput {
  snap: Snapshot
  events: ColisEvent[]
  shortages: StockShortage[]
  settings: Settings
  now?: number
}

/** Seuil technique volontairement très haut : il détecte une saisie cassée, pas une performance. */
export const MAX_PLAUSIBLE_RATE = 1_000

/**
 * Contrôles déterministes et intégralement locaux. Ils ne corrigent jamais les
 * données : chaque résultat explique quoi vérifier et désigne l'éditeur à ouvrir.
 */
export function inspectIntegrity({
  snap,
  events,
  shortages,
  settings,
  now = Date.now(),
}: IntegrityInput): IntegrityIssue[] {
  const workday = snap.workday
  if (!workday) return []
  const issues: IntegrityIssue[] = []
  const segments = snap.segments.filter((row) => !row.deletedAt)
  const orders = snap.orders.filter((row) => !row.deletedAt)
  const liveEvents = events.filter((row) => !row.deletedAt)
  const liveShortages = shortages.filter((row) => !row.deletedAt)

  const openSegments = segments.filter((segment) => segment.endedAt === undefined)
  for (const segment of openSegments) {
    const threshold = timerThreshold(segment, settings)
    if (now - segment.startedAt <= threshold) continue
    issues.push(issue({
      rule: 'stuck_timer', severity: 'check', entity: 'segment', entityId: segment.id,
      fingerprint: fingerprint(segment),
      title: 'Chrono peut-être oublié',
      detail: `« ${segmentDef(segment.type).label} » tourne depuis ${Math.floor((now - segment.startedAt) / MINUTE)} min.`,
      correction: "Vérifie l'heure de début ou termine le chrono depuis le tracé.",
    }))
  }

  if (workday.status === 'open' && dayKey(now) !== workday.date) {
    issues.push(issue({
      rule: 'stale_workday', severity: 'blocking', entity: 'workday', entityId: workday.id,
      fingerprint: fingerprint(workday, ...openSegments),
      title: 'Vacation encore ouverte le lendemain',
      detail: `La vacation du ${workday.date} est toujours ouverte. Sa durée fausserait le bilan.`,
      correction: 'Contrôle le dernier chrono puis clôture la vacation à la bonne heure.',
    }))
  }

  for (const order of orders) {
    const negative = Object.entries(order.supports).filter(([, count]) => count < 0)
    if (negative.length === 0) continue
    issues.push(issue({
      rule: 'negative_supports', severity: 'blocking', entity: 'order', entityId: order.id,
      fingerprint: fingerprint(order),
      title: 'Nombre de supports négatif',
      detail: `${negative.map(([kind, count]) => `${kind} : ${count}`).join(', ')}.`,
      correction: 'Ouvre la commande et remets les quantités de supports à zéro ou plus.',
    }))
  }

  for (const order of orders.filter((row) => row.status === 'done')) {
    const ownEvents = liveEvents.filter((row) => row.orderId === order.id)
    const ownShortages = liveShortages.filter((row) => row.orderId === order.id)
    const prepared = orderColis(order, ownEvents)
    const shortage = ownShortages.reduce((sum, row) => sum + row.quantity, 0)
    if (prepared + shortage !== order.colisPlanned) {
      const difference = Math.abs(order.colisPlanned - prepared - shortage)
      const direction = prepared + shortage < order.colisPlanned ? 'manquent' : 'sont en trop'
      issues.push(issue({
        rule: 'unexplained_count', severity: 'check', entity: 'order', entityId: order.id,
        fingerprint: fingerprint(order, ...ownEvents, ...ownShortages),
        title: `${difference} colis ${direction} sans explication`,
        detail: `${order.colisPlanned} prévus, ${prepared} préparés et ${shortage} en rupture.`,
        correction: 'Corrige le total préparé ou ajoute la rupture réellement constatée.',
      }))
    }

    const ownSegments = segments.filter((row) => row.orderId === order.id)
    const missing = (['wrapping', 'docking'] as const)
      .filter((type) => !ownSegments.some((segment) => segment.type === type))
      .map((type) => segmentDef(type).label.toLowerCase())
    if (missing.length > 0) {
      issues.push(issue({
        rule: 'missing_order_phase', severity: 'check', entity: 'order', entityId: order.id,
        fingerprint: fingerprint(order, ...ownSegments),
        title: 'Commande terminée avec une étape manquante',
        detail: `Aucun chrono de ${missing.join(' ni de ')} n'est enregistré.`,
        correction: 'Vérifie le tracé ; corrige la commande uniquement si cette absence est réelle.',
      }))
    }

    const metrics = computeOrderMetrics(order, ownSegments, ownEvents, now)
    if (metrics.totalWorked >= MIN_RATE_WINDOW && metrics.rateOrder > MAX_PLAUSIBLE_RATE) {
      issues.push(issue({
        rule: 'impossible_rate', severity: 'information', entity: 'order', entityId: order.id,
        fingerprint: fingerprint(order, ...ownSegments, ...ownEvents),
        title: 'Cadence techniquement improbable',
        detail: `${Math.round(metrics.rateOrder)} colis/h dépasse le seuil de contrôle de ${MAX_PLAUSIBLE_RATE} colis/h.`,
        correction: 'Vérifie le nombre de colis et les bornes des chronos ; ce contrôle ne juge pas la performance.',
      }))
    }

    if (shortage > 0 && prepared + shortage > order.colisPlanned) {
      issues.push(issue({
        rule: 'shortage_mismatch', severity: 'check', entity: 'shortage', entityId: ownShortages[0].id,
        fingerprint: fingerprint(order, ...ownShortages),
        title: 'Rupture incohérente avec le bilan',
        detail: `${prepared} préparés + ${shortage} en rupture dépassent les ${order.colisPlanned} prévus.`,
        correction: 'Vérifie la quantité de rupture ou le total préparé de cette commande.',
      }))
    }
  }

  for (const shortage of liveShortages) {
    if (orders.some((order) => order.id === shortage.orderId)) continue
    issues.push(issue({
      rule: 'shortage_mismatch', severity: 'blocking', entity: 'shortage', entityId: shortage.id,
      fingerprint: fingerprint(shortage),
      title: 'Rupture sans commande',
      detail: `${shortage.quantity} colis en rupture ne peuvent pas être rattachés au bilan.`,
      correction: 'Supprime cette rupture orpheline ou restaure sa commande avant le bilan.',
    }))
  }

  issues.push(...timelineIssues(segments))
  issues.push(...duplicateIssues(orders, segments, liveEvents))
  return issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id))
}

function timelineIssues(segments: Segment[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  const sorted = [...segments].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const open = sorted.filter((segment) => segment.endedAt === undefined)
  if (open.length > 1) {
    issues.push(issue({
      rule: 'invalid_timeline', severity: 'blocking', entity: 'segment', entityId: open[0].id,
      fingerprint: fingerprint(...open),
      title: 'Plusieurs chronos ouverts',
      detail: `${open.length} segments sont ouverts simultanément.`,
      correction: 'Ouvre le tracé et ferme ou supprime les chronos en trop après vérification.',
      idSuffix: `open:${open.map((row) => row.id).join(':')}`,
    }))
  }
  for (const segment of sorted) {
    if (segment.endedAt === undefined || segment.endedAt >= segment.startedAt) continue
    issues.push(issue({
      rule: 'invalid_timeline', severity: 'blocking', entity: 'segment', entityId: segment.id,
      fingerprint: fingerprint(segment),
      title: 'Durée négative',
      detail: 'Ce chrono se termine avant son heure de début.',
      correction: 'Corrige les heures de début et de fin depuis le tracé.',
      idSuffix: `negative:${segment.id}`,
    }))
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    if (previous.endedAt === undefined || previous.endedAt === current.startedAt) continue
    const gap = current.startedAt - previous.endedAt
    issues.push(issue({
      rule: 'invalid_timeline', severity: 'blocking', entity: 'segment', entityId: current.id,
      fingerprint: fingerprint(previous, current),
      title: gap > 0 ? 'Trou dans le tracé' : 'Chronos qui se chevauchent',
      detail: `${Math.max(1, Math.round(Math.abs(gap) / 1_000))} s ${gap > 0 ? 'ne sont rattachées à aucun chrono' : 'sont comptées deux fois'}.`,
      correction: 'Ajuste la borne entre ces deux chronos depuis le tracé.',
      idSuffix: `${gap > 0 ? 'gap' : 'overlap'}:${previous.id}:${current.id}`,
    }))
  }
  return issues
}

function duplicateIssues(orders: Order[], segments: Segment[], events: ColisEvent[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  const pairs = <T,>(rows: T[], duplicate: (a: T, b: T) => boolean) => {
    const found: [T, T][] = []
    for (let a = 0; a < rows.length; a += 1) {
      for (let b = a + 1; b < rows.length; b += 1) {
        if (duplicate(rows[a], rows[b])) found.push([rows[a], rows[b]])
      }
    }
    return found
  }
  for (const [a, b] of pairs(orders, (left, right) =>
    left.id !== right.id && left.orderType === right.orderType && left.colisPlanned === right.colisPlanned &&
    left.linesCount === right.linesCount && Math.abs(left.startedAt - right.startedAt) <= 5_000)) {
    issues.push(duplicateIssue('order', a, b, 'Deux commandes presque identiques ont été créées à quelques secondes d’intervalle.'))
  }
  for (const [a, b] of pairs(segments, (left, right) =>
    left.id !== right.id && left.type === right.type && left.orderId === right.orderId &&
    Math.abs(left.startedAt - right.startedAt) <= 1_000 && closeEnough(left.endedAt, right.endedAt))) {
    issues.push(duplicateIssue('segment', a, b, 'Deux chronos presque identiques ont probablement été importés deux fois.'))
  }
  // Deux appuis rapides sont parfaitement légitimes avec les boutons +1/+10.
  // Une copie issue d'une restauration conserve en revanche le même horodatage.
  // Le regroupement exact évite aussi un parcours quadratique sur les centaines
  // d'événements qu'une vacation peut contenir.
  const eventGroups = new Map<string, ColisEvent[]>()
  for (const event of events) {
    const key = `${event.orderId}|${event.palletId ?? ''}|${event.delta}|${event.at}`
    const group = eventGroups.get(key) ?? []
    group.push(event)
    eventGroups.set(key, group)
  }
  for (const group of eventGroups.values()) {
    if (group.length < 2) continue
    const [a, b] = group
    issues.push(duplicateIssue('order', a, b, 'Deux appuis identiques ont été enregistrés au même instant.'))
  }
  return issues
}

function duplicateIssue(
  entity: 'order' | 'segment',
  a: { id: string; updatedAt: number; orderId?: string },
  b: { id: string; updatedAt: number; orderId?: string },
  detail: string,
): IntegrityIssue {
  const ids = [a.id, b.id].sort()
  return issue({
    rule: 'probable_duplicate', severity: 'check', entity,
    entityId: entity === 'order' ? (a.orderId ?? a.id) : a.id,
    fingerprint: fingerprint(a, b), title: 'Doublon probable après synchronisation', detail,
    correction: 'Compare les deux éléments avant de supprimer celui qui est en trop.',
    idSuffix: `${entity}:${ids.join(':')}`,
  })
}

function timerThreshold(segment: Segment, settings: Settings): number {
  if (segment.type === 'break_10' || segment.type === 'break_30') return settings.stuckThresholds.break * MINUTE
  return (isInterruption(segment.type) ? settings.stuckThresholds.interruption : settings.stuckThresholds.order) * MINUTE
}

function closeEnough(left?: number, right?: number): boolean {
  if (left === undefined || right === undefined) return left === right
  return Math.abs(left - right) <= 1_000
}

function fingerprint(...rows: Array<{ id: string; updatedAt: number }>): string {
  return rows.map((row) => `${row.id}@${row.updatedAt}`).sort().join('|')
}

function issue(input: Omit<IntegrityIssue, 'id'> & { idSuffix?: string }): IntegrityIssue {
  const { idSuffix, ...value } = input
  return { ...value, id: `${value.rule}:${idSuffix ?? value.entityId}` }
}

function severityRank(severity: IntegritySeverity): number {
  return severity === 'blocking' ? 3 : severity === 'check' ? 2 : 1
}
