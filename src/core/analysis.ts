import type { DayMetrics, OrderMetrics } from './metrics'
import { isRateMeaningful, rate, segmentDuration } from './metrics'
import { segmentDef } from './segments'
import { HOUR } from './time'
import type {
  ColisEvent,
  OrderType,
  Segment,
  SegmentType,
  StockShortage,
  SupportKind,
} from './types'

/**
 * Analyses croisées sur plusieurs vacations.
 *
 * Chaque résultat porte le nombre d'observations qui le fonde. Sans cela, une
 * moyenne calculée sur une seule commande s'afficherait avec le même aplomb
 * qu'une tendance établie sur trois semaines — et orienterait le travail dans
 * le vide.
 */

export interface DayData {
  id: string
  date: string
  segments: Segment[]
  events: ColisEvent[]
  /** Absent sur les anciennes données et les fixtures antérieures à cette fonctionnalité. */
  shortages?: StockShortage[]
  metrics: DayMetrics
}

export interface Bucket {
  key: string
  label: string
  colis: number
  /** Temps retenu au dénominateur, en millisecondes. */
  time: number
  rate: number
  /** Nombre de commandes ou de journées derrière ce chiffre. */
  samples: number
}

/** En dessous, on n'affiche pas de comparaison : le hasard domine. */
export const MIN_SAMPLES = 3

function toBucket(key: string, label: string, colis: number, time: number, samples: number): Bucket {
  return { key, label, colis, time, rate: rate(colis, time), samples }
}

function sortByRate(buckets: Bucket[]): Bucket[] {
  return buckets
    .filter((b) => b.samples > 0 && isRateMeaningful(b.time))
    .sort((a, b) => b.rate - a.rate)
}

// --- Par type de commande --------------------------------------------------

const TYPE_LABELS: Record<OrderType, string> = {
  normale: 'Normale',
  urbaine: 'Urbaine',
  geprocor: 'Geprocor',
}

export function byOrderType(days: DayData[]): Bucket[] {
  const acc = new Map<OrderType, { colis: number; time: number; n: number }>()

  for (const day of days) {
    for (const order of day.metrics.orders) {
      const key = order.order.orderType
      const current = acc.get(key) ?? { colis: 0, time: 0, n: 0 }
      current.colis += order.colis
      current.time += order.totalWorked
      current.n += 1
      acc.set(key, current)
    }
  }

  return sortByRate(
    [...acc.entries()].map(([key, v]) => toBucket(key, TYPE_LABELS[key], v.colis, v.time, v.n)),
  )
}

// --- Par densité de la commande -------------------------------------------

/**
 * Le nombre de colis par ligne explique l'essentiel des écarts de cadence :
 * prendre 100 colis sur 10 références n'a rien à voir avec 100 colis sur 80.
 * Sans ce découpage, une mauvaise journée passe pour une baisse de régime alors
 * qu'elle ne reflète que des commandes plus émiettées.
 */
export const DENSITY_BUCKETS = [
  { key: 'tres-eclatee', label: 'Moins de 1,5 colis/ligne', max: 1.5 },
  { key: 'eclatee', label: '1,5 à 3 colis/ligne', max: 3 },
  { key: 'moyenne', label: '3 à 6 colis/ligne', max: 6 },
  { key: 'groupee', label: 'Plus de 6 colis/ligne', max: Infinity },
]

export function byDensity(days: DayData[]): Bucket[] {
  const acc = new Map<string, { colis: number; time: number; n: number }>()

  for (const day of days) {
    for (const order of day.metrics.orders) {
      if (order.order.linesCount <= 0) continue
      const density = order.colis / order.order.linesCount
      const bucket = DENSITY_BUCKETS.find((b) => density < b.max) ?? DENSITY_BUCKETS.at(-1)!
      const current = acc.get(bucket.key) ?? { colis: 0, time: 0, n: 0 }
      current.colis += order.colis
      current.time += order.picking
      current.n += 1
      acc.set(bucket.key, current)
    }
  }

  return DENSITY_BUCKETS.filter((b) => acc.has(b.key))
    .map((b) => {
      const v = acc.get(b.key)!
      return toBucket(b.key, b.label, v.colis, v.time, v.n)
    })
    .filter((b) => b.samples > 0 && isRateMeaningful(b.time))
}

// --- Courbe de fatigue -----------------------------------------------------

export interface HourPoint {
  hour: number
  colis: number
  pickingTime: number
  rate: number
  days: number
}

/**
 * Répartit les colis dans la journée pour repérer un décrochage horaire.
 *
 * Le compteur de progression fournit l'heure exacte de chaque colis quand il a
 * servi. Sinon on répartit le total de la commande sur ses segments de prépa,
 * au prorata du temps : moins précis, mais cela évite qu'une journée sans
 * comptage disparaisse purement et simplement de l'analyse.
 */
export function byHour(days: DayData[]): HourPoint[] {
  const colisPerHour = new Map<number, number>()
  const timePerHour = new Map<number, number>()
  const daysPerHour = new Map<number, Set<string>>()

  const add = (map: Map<number, number>, hour: number, value: number) => {
    map.set(hour, (map.get(hour) ?? 0) + value)
  }

  for (const day of days) {
    // Temps de prélèvement par heure, en découpant les segments à cheval.
    for (const segment of day.segments) {
      if (segment.type !== 'picking' || segment.deletedAt) continue
      spreadOverHours(segment.startedAt, segment.endedAt ?? segment.startedAt, (hour, ms) => {
        add(timePerHour, hour, ms)
        const set = daysPerHour.get(hour) ?? new Set<string>()
        set.add(day.id)
        daysPerHour.set(hour, set)
      })
    }

    for (const order of day.metrics.orders) {
      const counted = day.events.filter((e) => e.orderId === order.order.id && !e.deletedAt)

      if (counted.length > 0) {
        for (const event of counted) add(colisPerHour, new Date(event.at).getHours(), event.delta)
        continue
      }

      // Pas de comptage : on répartit au prorata du temps de prépa.
      const picking = day.segments.filter(
        (s) => s.orderId === order.order.id && s.type === 'picking' && !s.deletedAt,
      )
      const total = picking.reduce((sum, s) => sum + segmentDuration(s), 0)
      if (total <= 0) continue
      for (const segment of picking) {
        spreadOverHours(segment.startedAt, segment.endedAt ?? segment.startedAt, (hour, ms) => {
          add(colisPerHour, hour, (order.colis * ms) / total)
        })
      }
    }
  }

  return [...timePerHour.keys()]
    .sort((a, b) => a - b)
    .map((hour) => {
      const colis = colisPerHour.get(hour) ?? 0
      const pickingTime = timePerHour.get(hour) ?? 0
      return {
        hour,
        colis: Math.round(colis),
        pickingTime,
        rate: rate(colis, pickingTime),
        days: daysPerHour.get(hour)?.size ?? 0,
      }
    })
    .filter((point) => point.pickingTime > 5 * 60_000)
}

/** Découpe un intervalle en tranches horaires locales. */
function spreadOverHours(from: number, to: number, visit: (hour: number, ms: number) => void) {
  let cursor = from
  let guard = 0
  while (cursor < to && guard++ < 48) {
    const date = new Date(cursor)
    const endOfHour = new Date(date)
    endOfHour.setMinutes(60, 0, 0)
    const slice = Math.min(to, endOfHour.getTime())
    visit(date.getHours(), slice - cursor)
    cursor = slice
  }
}

// --- Par jour de la semaine ------------------------------------------------

const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']

export function byWeekday(days: DayData[]): Bucket[] {
  const acc = new Map<number, { colis: number; time: number; n: number }>()

  for (const day of days) {
    const [y, m, d] = day.date.split('-').map(Number)
    const weekday = new Date(y, m - 1, d).getDay()
    const current = acc.get(weekday) ?? { colis: 0, time: 0, n: 0 }
    current.colis += day.metrics.colis
    current.time += day.metrics.worked
    current.n += 1
    acc.set(weekday, current)
  }

  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekday, v]) => toBucket(String(weekday), WEEKDAYS[weekday], v.colis, v.time, v.n))
    .filter((b) => isRateMeaningful(b.time))
}

// --- Aléas et temps perdu --------------------------------------------------

export interface LossLine {
  type: SegmentType
  label: string
  emoji: string
  time: number
  count: number
  /** Colis qu'on aurait pu préparer sur ce temps, à la cadence cible. */
  colisEquivalent: number
  /** Occurrences par vacation, pour comparer des périodes de longueurs inégales. */
  perDay: number
}

export function losses(days: DayData[], targetRate: number): LossLine[] {
  const acc = new Map<SegmentType, { time: number; count: number }>()

  for (const day of days) {
    for (const segment of day.segments) {
      if (segment.deletedAt) continue
      const def = segmentDef(segment.type)
      if (def.category !== 'waste') continue
      const current = acc.get(segment.type) ?? { time: 0, count: 0 }
      current.time += segmentDuration(segment)
      current.count += 1
      acc.set(segment.type, current)
    }
  }

  const dayCount = Math.max(1, days.length)

  return [...acc.entries()]
    .map(([type, v]) => ({
      type,
      label: segmentDef(type).label,
      emoji: segmentDef(type).emoji,
      time: v.time,
      count: v.count,
      colisEquivalent: (v.time / HOUR) * targetRate,
      perDay: v.count / dayCount,
    }))
    .sort((a, b) => b.time - a.time)
}

/** Aléas subis par préparateur, pour repérer un problème récurrent de poste. */
export function incidentsByOwner(
  days: DayData[],
  targetRate: number,
): Map<string, LossLine[]> {
  const byOwner = new Map<string, DayData[]>()
  for (const day of days) {
    const owner = ownerOf(day)
    if (!owner) continue
    const list = byOwner.get(owner) ?? []
    list.push(day)
    byOwner.set(owner, list)
  }

  const out = new Map<string, LossLine[]>()
  for (const [owner, ownerDays] of byOwner) {
    // Les aléas seuls : trajets et temps morts relèvent de l'organisation, pas
    // d'un problème subi sur lequel un gestionnaire peut agir.
    const lines = losses(ownerDays, targetRate).filter(
      (l) => l.type.startsWith('incident_') || l.type.startsWith('custom_'),
    )
    if (lines.length > 0) out.set(owner, lines)
  }
  return out
}

// --- Bilan d'une journée d'équipe -----------------------------------------

/**
 * État de la vacation d'un préparateur pour une date.
 *
 * Sans réseau dans l'entrepôt, les données n'arrivent qu'à la sortie : il faut
 * distinguer « n'a pas travaillé » de « n'a pas encore synchronisé », sans quoi
 * un total d'équipe amputé se lirait comme une contre-performance.
 */
export type OwnerDayState =
  /** Journée close : chiffres complets et fiables. */
  | 'closed'
  /** Vacation encore ouverte, durée plausible : en cours, ou clôture oubliée du jour. */
  | 'open'
  /** Chrono resté ouvert au-delà d'un poste : la durée n'a plus de sens. */
  | 'stale'
  /** Préparateur actif dont rien n'est arrivé pour cette date. */
  | 'missing'

/** Au-delà, une vacation encore ouverte est forcément un oubli de clôture. */
export const STALE_AFTER = 16 * HOUR

export interface OwnerDay {
  ownerId: string
  state: OwnerDayState
  workdayId?: string
  colis: number
  worked: number
  rate: number
  wasteTime: number
  incidentCount: number
  ordersCount: number
  shortageQuantity: number
  unresolvedShortages: number
  /** Dernier instant enregistré, pour situer la fraîcheur de ce qui est remonté. */
  lastActivity?: number
  /** Vrai quand les chiffres peuvent entrer dans les totaux de l'équipe. */
  countable: boolean
}

/**
 * Bilan d'une date, préparateur par préparateur.
 *
 * `knownOwners` permet de faire apparaître ceux dont rien n'est arrivé : c'est
 * précisément l'information qu'un gestionnaire doit voir avant de conclure quoi
 * que ce soit sur la journée.
 */
export function byOwnerForDate(
  days: DayData[],
  date: string,
  knownOwners: string[] = [],
): OwnerDay[] {
  const forDate = days.filter((d) => d.date === date)
  const seen = new Set<string>()
  const out: OwnerDay[] = []

  for (const day of forDate) {
    const ownerId = ownerOf(day)
    if (!ownerId) continue
    seen.add(ownerId)

    const open = day.metrics.endedAt === undefined
    const stale = open && day.metrics.presence > STALE_AFTER
    const state: OwnerDayState = stale ? 'stale' : open ? 'open' : 'closed'
    // Une vacation dont le chrono a tourné toute la nuit fausserait la cadence
    // de toute l'équipe : elle est montrée, mais pas comptée.
    const countable = state !== 'stale'

    const incidentCount = day.segments.filter(
      (s) =>
        !s.deletedAt && (s.type.startsWith('incident_') || s.type.startsWith('custom_')),
    ).length
    const shortages = (day.shortages ?? []).filter((shortage) => !shortage.deletedAt)

    const lastActivity = day.segments.reduce(
      (max, s) => Math.max(max, s.endedAt ?? s.startedAt),
      0,
    )

    out.push({
      ownerId,
      state,
      workdayId: day.id,
      colis: day.metrics.colis,
      worked: day.metrics.worked,
      rate: day.metrics.rates.day,
      wasteTime: day.metrics.wasteTime,
      incidentCount,
      ordersCount: day.metrics.ordersCount,
      shortageQuantity: shortages.reduce((sum, shortage) => sum + shortage.quantity, 0),
      unresolvedShortages: shortages.filter((shortage) => !shortage.resolved).length,
      lastActivity: lastActivity > 0 ? lastActivity : undefined,
      countable,
    })
  }

  for (const ownerId of knownOwners) {
    if (seen.has(ownerId)) continue
    out.push({
      ownerId,
      state: 'missing',
      colis: 0,
      worked: 0,
      rate: 0,
      wasteTime: 0,
      incidentCount: 0,
      ordersCount: 0,
      shortageQuantity: 0,
      unresolvedShortages: 0,
      countable: false,
    })
  }

  return out
}

export interface TeamDayTotals {
  colis: number
  worked: number
  /** Colis totaux divisés par le temps total : jamais une moyenne de cadences. */
  rate: number
  wasteTime: number
  ordersCount: number
  /** Préparateurs dont les chiffres entrent dans ces totaux. */
  counted: number
  /** Préparateurs écartés : chrono resté ouvert, ou rien reçu. */
  excluded: number
}

/**
 * Totaux d'une journée d'équipe.
 *
 * La cadence se calcule en sommant colis et temps avant de diviser. Une moyenne
 * des cadences individuelles donnerait le même poids à une demi-journée qu'à un
 * poste complet.
 */
export function teamDayTotals(rows: OwnerDay[]): TeamDayTotals {
  const counted = rows.filter((r) => r.countable && r.worked > 0)
  const colis = counted.reduce((sum, r) => sum + r.colis, 0)
  const worked = counted.reduce((sum, r) => sum + r.worked, 0)

  return {
    colis,
    worked,
    rate: rate(colis, worked),
    wasteTime: counted.reduce((sum, r) => sum + r.wasteTime, 0),
    ordersCount: counted.reduce((sum, r) => sum + r.ordersCount, 0),
    counted: counted.length,
    excluded: rows.length - counted.length,
  }
}

/** Dates présentes dans les données, de la plus récente à la plus ancienne. */
export function availableDates(days: DayData[]): string[] {
  return [...new Set(days.map((d) => d.date))].sort((a, b) => b.localeCompare(a))
}

// --- Supports --------------------------------------------------------------

export function bySupport(days: DayData[]): Bucket[] {
  const acc = new Map<SupportKind, { colis: number; time: number; n: number }>()
  const labels: Record<SupportKind, string> = {
    europe: 'Palette Europe',
    ipp: 'Palette IPP',
    demi: 'Demi-palette',
    vmax: 'Vmax',
    vrac: 'Vrac',
    perdue: 'Palette perdue',
  }

  for (const day of days) {
    for (const order of day.metrics.orders) {
      const entries = (Object.entries(order.order.supports) as [SupportKind, number][]).filter(
        ([, n]) => n > 0,
      )
      if (entries.length === 0) continue
      // Le support dominant caractérise la commande ; la répartir entre
      // plusieurs supports mélangerait des temps qui ne sont pas séparables.
      const [dominant] = entries.sort((a, b) => b[1] - a[1])
      const current = acc.get(dominant[0]) ?? { colis: 0, time: 0, n: 0 }
      current.colis += order.colis
      current.time += order.totalWorked
      current.n += 1
      acc.set(dominant[0], current)
    }
  }

  return sortByRate(
    [...acc.entries()].map(([key, v]) => toBucket(key, labels[key], v.colis, v.time, v.n)),
  )
}

// --- Comparaison entre préparateurs ---------------------------------------

/**
 * Cadences de référence de l'équipe, par tranche de densité de commande.
 *
 * C'est l'étalon qui rend les préparateurs comparables. Il est calculé sur
 * l'ensemble de l'équipe, pas sur une cible théorique : la référence est ce que
 * l'équipe fait réellement sur ce type de commande.
 */
export function referenceRates(days: DayData[]): Bucket[] {
  return byDensity(days)
}

export interface OwnerPerformance {
  ownerId: string
  colis: number
  /** Temps de prélèvement retenu, en millisecondes. */
  pickingTime: number
  /** Cadence de prélèvement réellement constatée. */
  observedRate: number
  /** Cadence qu'on attendrait vu la densité des commandes reçues. */
  expectedRate: number
  /** Observé − attendu : le seul chiffre comparable d'une personne à l'autre. */
  delta: number
  /** Nombre de commandes exploitables derrière ce calcul. */
  samples: number
  days: number
  /**
   * Part des colis traités dans des tranches de densité où au moins un autre
   * préparateur travaille aussi.
   *
   * Sans cela, un préparateur seul sur son type de commande se compare à
   * lui-même : sa performance devient la référence de sa tranche et son écart
   * vaut mécaniquement zéro. Afficher « pile dans la norme » dans ce cas serait
   * un mensonge par construction.
   */
  comparableShare: number
}

/** En dessous, l'écart n'est pas interprétable : trop peu de terrain commun. */
export const MIN_COMPARABLE_SHARE = 0.5

/**
 * Performance de chacun, corrigée de la difficulté des commandes reçues.
 *
 * Comparer des cadences brutes entre préparateurs est faux : celui qui reçoit
 * les commandes les plus éclatées sort mécaniquement plus bas, sans que son
 * rythme soit en cause. On calcule donc, pour chaque personne, le temps qu'il
 * aurait fallu à la cadence de référence de l'équipe **sur ses propres
 * commandes**, et on en déduit une cadence attendue.
 *
 * L'agrégation se fait par le temps, pas par la moyenne des cadences : faire la
 * moyenne arithmétique de deux cadences donnerait un résultat faux dès que les
 * commandes n'ont pas la même taille. On somme des heures, puis on divise.
 *
 * Les commandes sans nombre de lignes sont écartées : leur densité est inconnue,
 * les inclure reviendrait à comparer sans étalon.
 */
export function performanceByOwner(
  days: DayData[],
  reference: Bucket[] = referenceRates(days),
): OwnerPerformance[] {
  const rateByBucket = new Map(reference.map((b) => [b.key, b.rate]))
  // Qui travaille sur quelle tranche : une tranche fréquentée par une seule
  // personne ne permet aucune comparaison.
  const ownersPerBucket = new Map<string, Set<string>>()
  for (const day of days) {
    const owner = ownerOf(day)
    if (!owner) continue
    for (const order of day.metrics.orders) {
      const key = bucketOf(order.colis, order.order.linesCount)
      if (!key) continue
      const set = ownersPerBucket.get(key) ?? new Set<string>()
      set.add(owner)
      ownersPerBucket.set(key, set)
    }
  }

  const acc = new Map<
    string,
    {
      colis: number
      picking: number
      expectedHours: number
      samples: number
      days: Set<string>
      sharedColis: number
    }
  >()

  for (const day of days) {
    const ownerId = day.metrics.orders[0]?.order.ownerId ?? ownerOf(day)
    if (ownerId === undefined) continue

    for (const order of day.metrics.orders) {
      const key = bucketOf(order.colis, order.order.linesCount)
      if (!key || order.picking <= 0) continue

      const refRate = rateByBucket.get(key)
      if (!refRate || refRate <= 0) continue

      const current = acc.get(ownerId) ?? {
        colis: 0,
        picking: 0,
        expectedHours: 0,
        samples: 0,
        days: new Set<string>(),
        sharedColis: 0,
      }
      current.colis += order.colis
      current.picking += order.picking
      // Temps qu'il aurait fallu à la cadence de référence pour cette commande.
      current.expectedHours += order.colis / refRate
      current.samples += 1
      current.days.add(day.id)
      if ((ownersPerBucket.get(key)?.size ?? 0) > 1) current.sharedColis += order.colis
      acc.set(ownerId, current)
    }
  }

  return [...acc.entries()]
    .map(([ownerId, v]) => {
      const observedRate = rate(v.colis, v.picking)
      const expectedRate = v.expectedHours > 0 ? v.colis / v.expectedHours : 0
      return {
        ownerId,
        colis: v.colis,
        pickingTime: v.picking,
        observedRate,
        expectedRate,
        delta: expectedRate > 0 ? observedRate - expectedRate : 0,
        samples: v.samples,
        days: v.days.size,
        comparableShare: v.colis > 0 ? v.sharedColis / v.colis : 0,
      }
    })
    .sort((a, b) => b.delta - a.delta)
}

/** Tranche de densité d'une commande, ou `undefined` si elle est inexploitable. */
function bucketOf(colis: number, lines: number): string | undefined {
  if (lines <= 0 || colis <= 0) return undefined
  const density = colis / lines
  return (DENSITY_BUCKETS.find((b) => density < b.max) ?? DENSITY_BUCKETS.at(-1)!).key
}

/** Propriétaire d'une vacation, déduit de ses segments. */
/** Propriétaire d'une vacation, déduit de ses segments. */
export function ownerOf(day: DayData): string | undefined {
  return day.segments.find((s) => s.ownerId !== undefined)?.ownerId
}

// --- Meilleures et pires journées -----------------------------------------

export interface DaySpread {
  best: DayData[]
  worst: DayData[]
  bestRate: number
  worstRate: number
  gap: number
}

/** Sépare le quart haut et le quart bas des vacations, par cadence journée. */
export function spread(days: DayData[]): DaySpread | undefined {
  const usable = days.filter(
    (d) => d.metrics.colis > 0 && isRateMeaningful(d.metrics.worked),
  )
  if (usable.length < 4) return undefined

  const sorted = [...usable].sort((a, b) => b.metrics.rates.day - a.metrics.rates.day)
  const size = Math.max(1, Math.floor(sorted.length / 4))
  const best = sorted.slice(0, size)
  const worst = sorted.slice(-size)

  const average = (list: DayData[]) =>
    list.reduce((sum, d) => sum + d.metrics.rates.day, 0) / list.length

  const bestRate = average(best)
  const worstRate = average(worst)
  return { best, worst, bestRate, worstRate, gap: bestRate - worstRate }
}

/** Moyenne d'une grandeur sur un ensemble de journées. */
export function averageOf(days: DayData[], pick: (d: DayMetrics) => number): number {
  if (days.length === 0) return 0
  return days.reduce((sum, d) => sum + pick(d.metrics), 0) / days.length
}

export function allOrders(days: DayData[]): OrderMetrics[] {
  return days.flatMap((d) => d.metrics.orders)
}
