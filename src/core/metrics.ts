import type { Snapshot } from './machine'
import { categoryOf, segmentDef } from './segments'
import type { SegmentCategory } from './segments'
import { HOUR, toHours } from './time'
import type { ColisEvent, Order, OrderPallet, Segment, SegmentType } from './types'

export interface PalletMetrics {
  pallet: OrderPallet
  colis: number
  picking: number
  wrapping: number
  wrappingCount: number
}

export function computePalletMetrics(
  pallet: OrderPallet,
  segments: Segment[],
  events: ColisEvent[],
  now: number = Date.now(),
): PalletMetrics {
  const ownSegments = segments.filter((s) => s.palletId === pallet.id && !s.deletedAt)
  const duration = (type: SegmentType) => ownSegments
    .filter((s) => s.type === type)
    .reduce((sum, s) => sum + segmentDuration(s, now), 0)
  const eventTotal = events
    .filter((e) => e.palletId === pallet.id && !e.deletedAt)
    .reduce((sum, e) => sum + e.delta, 0)
  return {
    pallet,
    colis: Math.max(0, pallet.endCount ?? eventTotal),
    picking: duration('picking'),
    wrapping: duration('wrapping'),
    wrappingCount: ownSegments.filter((s) => s.type === 'wrapping').length,
  }
}

/**
 * Calcul des cadences.
 *
 * Comme la timeline est linéaire et non chevauchante, les interruptions sont
 * déjà des segments à part entière : il n'y a rien à soustraire, il suffit de
 * choisir quels segments entrent dans le dénominateur. C'est ce qui rend les
 * trois cadences à la fois simples à calculer et impossibles à double-compter.
 */

export function segmentDuration(seg: Segment, now: number = Date.now()): number {
  const end = seg.endedAt ?? now
  return Math.max(0, end - seg.startedAt)
}

export function isOpen(seg: Segment): boolean {
  return seg.endedAt === undefined && !seg.deletedAt
}

/** Colis réellement traités sur une commande, selon l'information disponible. */
export function orderColis(order: Order, events: ColisEvent[]): number {
  if (order.colisActual !== undefined) return order.colisActual
  const counted = events
    .filter((e) => e.orderId === order.id && !e.deletedAt)
    .reduce((sum, e) => sum + e.delta, 0)
  if (counted > 0) return counted
  return order.status === 'done' ? order.colisPlanned : 0
}

/** Cadence en colis/heure ; 0 si le temps est nul, pour éviter les infinis. */
export function rate(colis: number, ms: number): number {
  if (ms <= 0) return 0
  return colis / toHours(ms)
}

/**
 * En dessous de cette fenêtre, une cadence n'a aucune valeur informative :
 * quelques colis sur deux minutes extrapolent à plusieurs milliers par heure.
 * Les écrans affichent « — » plutôt qu'un chiffre spectaculaire et faux.
 */
export const MIN_RATE_WINDOW = 5 * 60_000

export function isRateMeaningful(ms: number): boolean {
  return ms >= MIN_RATE_WINDOW
}

/**
 * Temps subi, écarté du dénominateur des cadences.
 *
 * Un aléa — panne, attente, sollicitation — s'impose au préparateur. Un
 * changement de palette aussi : la palette est pleine, il faut la déposer et en
 * reprendre une. Compter ces minutes reviendrait à faire baisser la cadence
 * pour des raisons étrangères au rythme de préparation.
 *
 * Les trajets et les passages aux toilettes restent comptés : ils font partie
 * du déroulement normal et se réduisent par l'organisation.
 */
export function isImposed(type: SegmentType): boolean {
  return type === 'pallet_change' || type.startsWith('incident_') || type.startsWith('custom_')
}

/**
 * Temps cumulé d'une phase, tous segments confondus.
 *
 * Après un trajet, la préparation reprend dans un nouveau segment : afficher la
 * durée de ce seul segment donnerait « 0:00 » alors que la commande est
 * entamée depuis vingt minutes. C'est le cumul qui a du sens à l'écran.
 */
export function phaseElapsed(
  segments: Segment[],
  type: SegmentType,
  orderId: string | undefined,
  now: number = Date.now(),
): { elapsed: number; since: number } {
  const matching = segments.filter(
    (s) => s.type === type && s.orderId === orderId && !s.deletedAt,
  )
  if (matching.length === 0) return { elapsed: 0, since: now }
  return {
    elapsed: matching.reduce((sum, s) => sum + segmentDuration(s, now), 0),
    since: Math.min(...matching.map((s) => s.startedAt)),
  }
}

// --- Métriques d'une commande ---------------------------------------------

export interface OrderMetrics {
  order: Order
  colis: number
  /** Durées par type de segment rattaché à la commande. */
  byType: Partial<Record<SegmentType, number>>
  setup: number
  picking: number
  wrapping: number
  docking: number
  /** Interruptions hors pauses réglementaires. */
  interruptions: number
  /**
   * Temps subi, exclu de la cadence : aléas et changements de palette.
   *
   * Ces minutes ne dépendent pas du rythme de travail — une panne d'engin ou une
   * palette à remplacer s'imposent. Les laisser au dénominateur ferait baisser
   * la cadence pour une raison étrangère à la préparation elle-même.
   */
  imposed: number
  /** Pauses prises pendant la commande, exclues de tous les calculs de cadence. */
  breaks: number
  /** Durée retenue pour la cadence « commande complète ». */
  totalWorked: number
  /** Durée du premier au dernier instant, pauses comprises. */
  elapsed: number
  ratePicking: number
  rateOrder: number
  colisPerLine: number
  palletChanges: number
  pallets: PalletMetrics[]
}

export function computeOrderMetrics(
  order: Order,
  segments: Segment[],
  events: ColisEvent[],
  now: number = Date.now(),
): OrderMetrics {
  const own = segments.filter((s) => s.orderId === order.id && !s.deletedAt)
  const byType: Partial<Record<SegmentType, number>> = {}
  let interruptions = 0
  let imposed = 0
  let breaks = 0
  let palletChanges = 0

  for (const seg of own) {
    const d = segmentDuration(seg, now)
    byType[seg.type] = (byType[seg.type] ?? 0) + d
    const cat = categoryOf(seg.type)
    if (cat === 'break') breaks += d
    else if (segmentDef(seg.type).interruption) {
      interruptions += d
      if (isImposed(seg.type)) imposed += d
    }
    if (seg.type === 'pallet_change') palletChanges += 1
  }

  const setup = byType.order_setup ?? 0
  const picking = byType.picking ?? 0
  const wrapping = byType.wrapping ?? 0
  const docking = byType.docking ?? 0

  // Les pauses réglementaires sont exclues : une pause déjeuner prise au milieu
  // d'une commande n'a rien à voir avec le temps mis à la préparer. Les temps
  // subis le sont aussi : ils ne dépendent pas du rythme de travail.
  const totalWorked = setup + picking + wrapping + docking + interruptions - imposed
  const colis = orderColis(order, events)
  const end = order.endedAt ?? now

  return {
    order,
    colis,
    byType,
    setup,
    picking,
    wrapping,
    docking,
    interruptions,
    imposed,
    breaks,
    totalWorked,
    elapsed: Math.max(0, end - order.startedAt),
    ratePicking: rate(colis, picking),
    rateOrder: rate(colis, totalWorked),
    colisPerLine: order.linesCount > 0 ? colis / order.linesCount : 0,
    palletChanges,
    pallets: [],
  }
}

// --- Métriques d'une journée ----------------------------------------------

export interface DayMetrics {
  date: string
  /** Somme de tous les segments : le temps de présence effectif. */
  presence: number
  /** Présence moins les pauses réglementaires. */
  worked: number
  breaks: number
  /** Temps passé sur des segments rattachés à une commande, pauses exclues. */
  orderTime: number
  pickingTime: number
  wasteTime: number
  overheadTime: number
  overtime: number
  colis: number
  ordersCount: number
  byType: Partial<Record<SegmentType, number>>
  byCategory: Record<SegmentCategory, number>
  countByType: Partial<Record<SegmentType, number>>
  rates: {
    /** Colis / heures de prélèvement pur. */
    picking: number
    /** Colis / heures de commande, interruptions comprises, pauses exclues. */
    order: number
    /** Colis / heures de présence hors pauses. */
    day: number
  }
  /** Colis qu'on aurait pu faire avec le temps perdu, à la cadence cible. */
  lostColis: number
  orders: OrderMetrics[]
  startedAt: number
  endedAt?: number
}

const EMPTY_CATEGORIES: Record<SegmentCategory, number> = {
  productive: 0,
  necessary: 0,
  waste: 0,
  break: 0,
  overhead: 0,
}

export function computeDayMetrics(
  snap: Snapshot,
  events: ColisEvent[],
  targetRate: number,
  now: number = Date.now(),
): DayMetrics {
  const segments = snap.segments.filter((s) => !s.deletedAt)
  const byType: Partial<Record<SegmentType, number>> = {}
  const countByType: Partial<Record<SegmentType, number>> = {}
  const byCategory = { ...EMPTY_CATEGORIES }

  let presence = 0
  let breaks = 0
  let orderTime = 0
  let overtime = 0
  const overtimeStart = snap.workday?.overtimeStartedAt

  for (const seg of segments) {
    const d = segmentDuration(seg, now)
    const cat = categoryOf(seg.type)
    byType[seg.type] = (byType[seg.type] ?? 0) + d
    countByType[seg.type] = (countByType[seg.type] ?? 0) + 1
    byCategory[cat] += d
    presence += d
    if (cat === 'break') breaks += d
    else if (seg.orderId) orderTime += d

    if (overtimeStart !== undefined) {
      const end = seg.endedAt ?? now
      overtime += Math.max(0, end - Math.max(seg.startedAt, overtimeStart))
    }
  }

  const orders = snap.orders
    .filter((o) => !o.deletedAt)
    .map((o) => {
      const metrics = computeOrderMetrics(o, segments, events, now)
      metrics.pallets = (snap.pallets ?? [])
        .filter((p) => p.orderId === o.id && !p.deletedAt)
        .map((p) => computePalletMetrics(p, segments, events, now))
      return metrics
    })

  const colis = orders.reduce((sum, m) => sum + m.colis, 0)
  const pickingTime = byType.picking ?? 0
  const worked = presence - breaks

  return {
    date: snap.workday?.date ?? '',
    presence,
    worked,
    breaks,
    orderTime,
    pickingTime,
    wasteTime: byCategory.waste,
    overheadTime: byCategory.overhead,
    overtime,
    colis,
    ordersCount: orders.length,
    byType,
    byCategory,
    countByType,
    rates: {
      picking: rate(colis, pickingTime),
      order: rate(colis, orderTime),
      day: rate(colis, worked),
    },
    lostColis: (byCategory.waste / HOUR) * targetRate,
    orders,
    startedAt: snap.workday?.startedAt ?? 0,
    endedAt: snap.workday?.endedAt,
  }
}

// --- Suivi en direct pendant une commande ---------------------------------

export interface LiveStatus {
  counted: number
  planned: number
  remaining: number
  /** Colis attendus à cet instant au rythme cible, sur le temps de prépa écoulé. */
  expected: number
  /** Positif = en avance, négatif = en retard, exprimé en colis. */
  delta: number
  /** Cadence de prélèvement constatée depuis le début de la commande. */
  currentRate: number
  /** Fin estimée au rythme constaté, ou au rythme cible si trop peu de données. */
  estimatedEnd?: number
  /** Vrai tant que la cadence constatée repose sur trop peu de colis. */
  provisional: boolean
  progress: number
}

/**
 * Avance et retard en direct, sur le temps réellement écoulé.
 *
 * Le dénominateur court depuis le premier prélèvement et **inclut tout ce qui
 * l'a interrompu** : trajets, passages aux toilettes, aléas, changements de
 * palette. Pendant ces minutes-là aucun colis n'est préparé, la commande prend
 * donc du retard — que la cause soit imputable ou non. Geler le compteur
 * afficherait une avance qui n'existe pas et laisserait découvrir le retard en
 * fin de commande, trop tard pour réagir.
 *
 * Seules les pauses réglementaires sont retirées : ce sont des arrêts de
 * travail, pas des minutes perdues sur la commande.
 *
 * À ne pas confondre avec la cadence calculée après coup
 * (`computeOrderMetrics`), qui écarte au contraire les temps subis pour ne pas
 * les faire peser sur l'évaluation. Les deux mesures répondent à deux
 * questions différentes : « où en suis-je maintenant » et « quel a été mon
 * rythme ».
 */
export function computeLive(
  order: Order,
  segments: Segment[],
  events: ColisEvent[],
  targetRate: number,
  now: number = Date.now(),
): LiveStatus {
  const own = segments.filter((s) => s.orderId === order.id && !s.deletedAt)
  const pickingSegments = own.filter((s) => s.type === 'picking')

  const startedPicking =
    pickingSegments.length > 0 ? Math.min(...pickingSegments.map((s) => s.startedAt)) : undefined

  const breaksDuring = own
    .filter((s) => categoryOf(s.type) === 'break')
    .reduce((sum, s) => sum + segmentDuration(s, now), 0)

  // Temps écoulé depuis le début du prélèvement, pauses réglementaires déduites.
  const pickingTime =
    startedPicking === undefined ? 0 : Math.max(0, now - startedPicking - breaksDuring)

  const counted = events
    .filter((e) => e.orderId === order.id && !e.deletedAt)
    .reduce((sum, e) => sum + e.delta, 0)

  const planned = order.colisPlanned
  const expected = (pickingTime / HOUR) * targetRate
  const currentRate = rate(counted, pickingTime)
  const provisional = counted < 10 || pickingTime < 60_000
  const effectiveRate = provisional ? targetRate : currentRate
  const remaining = Math.max(0, planned - counted)

  let estimatedEnd: number | undefined
  if (effectiveRate > 0) {
    estimatedEnd = now + (remaining / effectiveRate) * HOUR
  }

  return {
    counted,
    planned,
    remaining,
    expected,
    delta: counted - expected,
    currentRate,
    estimatedEnd,
    provisional,
    progress: planned > 0 ? Math.min(1, counted / planned) : 0,
  }
}

/** Durée théorique d'une commande à la cadence cible. */
export function targetDuration(colis: number, targetRate: number): number {
  if (targetRate <= 0) return 0
  return (colis / targetRate) * HOUR
}
