import {
  allOrders,
  byDensity,
  byHour,
  losses,
  spread,
  type DayData,
  MIN_SAMPLES,
} from './analysis'
import { isRateMeaningful, rate } from './metrics'
import { formatShort, HOUR, MINUTE } from './time'

/**
 * Moteur de recommandations : des règles déterministes, pas de modèle.
 *
 * Trois exigences ont guidé l'écriture :
 *
 * 1. Tout fonctionne hors ligne et reste vérifiable à la main — un conseil sur
 *    la cadence doit pouvoir être recalculé sur un coin de table.
 * 2. Aucune règle ne parle sans un minimum d'observations. Un constat tiré de
 *    deux commandes ferait travailler sur du bruit.
 * 3. Chaque sortie est un constat chiffré, pas un jugement. Le métier est connu
 *    de celui qui le fait ; l'app apporte des minutes et des colis, pas des
 *    leçons.
 */

export interface Recommendation {
  id: string
  severity: 'high' | 'medium' | 'info'
  title: string
  detail: string
  action: string
  /** Fiabilité de l'échantillon, affichée telle quelle. */
  confidence: 'solide' | 'indicatif'
}

export interface RecoContext {
  days: DayData[]
  targetRate: number
}

export function recommend({ days, targetRate }: RecoContext): Recommendation[] {
  const usable = days.filter((d) => d.metrics.colis > 0)
  if (usable.length === 0) return []

  const out: Recommendation[] = []
  for (const rule of RULES) {
    const found = rule(usable, targetRate)
    if (found) out.push(found)
  }

  const order = { high: 0, medium: 1, info: 2 }
  return out.sort((a, b) => order[a.severity] - order[b.severity])
}

type Rule = (days: DayData[], targetRate: number) => Recommendation | undefined

const confidenceFor = (samples: number): Recommendation['confidence'] =>
  samples >= MIN_SAMPLES * 2 ? 'solide' : 'indicatif'

/** 1. Le poste de perte le plus coûteux, converti en colis. */
const topLoss: Rule = (days, targetRate) => {
  const [worst] = losses(days, targetRate)
  if (!worst || worst.time < 5 * MINUTE) return undefined

  const perDay = worst.time / days.length
  const colisPerDay = (perDay / HOUR) * targetRate
  if (colisPerDay < 5) return undefined

  return {
    id: 'top-loss',
    severity: colisPerDay > 40 ? 'high' : 'medium',
    title: `${worst.emoji} ${worst.label} : premier poste de temps perdu`,
    detail:
      days.length === 1
        ? `${formatShort(worst.time)} sur la journée, en ${worst.count} fois — soit ${Math.round(colisPerDay)} colis manquants estimés à ${targetRate}/h.`
        : `${formatShort(perDay)} par vacation en moyenne (${worst.perDay.toFixed(1)} fois par jour), soit ${Math.round(colisPerDay)} colis manquants estimés quotidiens.`,
    action:
      worst.type === 'travel'
        ? 'Regarde si des trajets peuvent être groupés, ou si ta palette peut te suivre au plus près du picking.'
        : worst.type === 'idle'
          ? "Ce sont des temps entre deux commandes. Vois si la commande suivante peut être lancée avant d'avoir fini de ranger la précédente."
          : 'Note la cause quand ça se reproduit : un motif récurrent se règle plus facilement avec des chiffres en main.',
    confidence: confidenceFor(days.length),
  }
}

/** 2. Décrochage de cadence en fin de vacation. */
const fatigue: Rule = (days) => {
  const points = byHour(days).filter((p) => p.rate > 0)
  if (points.length < 4) return undefined

  const mid = Math.floor(points.length / 2)
  const early = points.slice(0, mid)
  const late = points.slice(mid)
  const avg = (list: typeof points) =>
    list.reduce((sum, p) => sum + p.colis, 0) /
    (list.reduce((sum, p) => sum + p.pickingTime, 0) / HOUR)

  const earlyRate = avg(early)
  const lateRate = avg(late)
  if (!Number.isFinite(earlyRate) || !Number.isFinite(lateRate) || earlyRate <= 0) return undefined

  const drop = (earlyRate - lateRate) / earlyRate
  if (drop < 0.12) return undefined

  const from = late[0].hour
  return {
    id: 'fatigue',
    severity: drop > 0.25 ? 'high' : 'medium',
    title: `Cadence en baisse de ${Math.round(drop * 100)} % en seconde partie`,
    detail: `${Math.round(earlyRate)} colis/h avant ${from} h, ${Math.round(lateRate)} après.`,
    action:
      'Regarde si le placement de la grande pause peut mieux couper cette seconde partie, ou si les commandes les plus lourdes peuvent passer plus tôt.',
    confidence: confidenceFor(days.length),
  }
}

/** 3. Effet du nombre de références sur la cadence. */
const density: Rule = (days) => {
  const buckets = byDensity(days)
  if (buckets.length < 2) return undefined

  const sorted = [...buckets].sort((a, b) => b.rate - a.rate)
  const best = sorted[0]
  const worst = sorted[sorted.length - 1]
  if (best.samples < 2 || worst.samples < 2) return undefined

  const gap = best.rate - worst.rate
  if (gap < 15) return undefined

  return {
    id: 'density',
    severity: 'info',
    title: 'Ta cadence dépend surtout de la densité des commandes',
    detail: `${Math.round(best.rate)} colis/h sur « ${best.label.toLowerCase()} » contre ${Math.round(worst.rate)} sur « ${worst.label.toLowerCase() }» — ${Math.round(gap)} colis/h d'écart.`,
    action:
      "C'est structurel, pas un relâchement : une journée à commandes éclatées sortira mécaniquement plus bas. Utile à rappeler si on te compare à une autre journée.",
    confidence: confidenceFor(best.samples + worst.samples),
  }
}

/** 4. Temps de recherche de palette et d'étiquette. */
const setupCost: Rule = (days, targetRate) => {
  const orders = allOrders(days)
  if (orders.length < MIN_SAMPLES) return undefined

  const setup = orders.reduce((sum, o) => sum + o.setup, 0)
  const worked = orders.reduce((sum, o) => sum + o.totalWorked, 0)
  if (worked <= 0) return undefined

  const share = setup / worked
  if (share < 0.1) return undefined

  const perOrder = setup / orders.length
  return {
    id: 'setup',
    severity: share > 0.18 ? 'high' : 'medium',
    title: `Recherche palette et étiquette : ${Math.round(share * 100)} % du temps de commande`,
    detail: `${formatShort(perOrder)} en moyenne par commande, sur ${orders.length} commandes — environ ${Math.round((setup / HOUR) * targetRate)} colis manquants estimés sur la période.`,
    action:
      "Vois si un stock de palettes peut être préparé d'avance en début de poste, ou si les étiquettes peuvent être tirées par lot.",
    confidence: confidenceFor(orders.length),
  }
}

/** 5. Fréquence des changements de palette. */
const palletChanges: Rule = (days) => {
  const orders = allOrders(days)
  if (orders.length < MIN_SAMPLES) return undefined

  const changes = orders.reduce((sum, o) => sum + o.palletChanges, 0)
  const colis = orders.reduce((sum, o) => sum + o.colis, 0)
  if (changes < 3 || colis <= 0) return undefined

  const time = days.reduce((sum, d) => sum + (d.metrics.byType.pallet_change ?? 0), 0)
  const colisPerChange = colis / changes
  if (colisPerChange > 60) return undefined

  return {
    id: 'pallet',
    severity: 'info',
    title: `Un changement de palette tous les ${Math.round(colisPerChange)} colis`,
    detail: `${changes} changements pour ${formatShort(time)} au total, soit ${formatShort(time / changes)} à chaque fois.`,
    action:
      'Si les palettes partent peu remplies, vérifie si le montage peut être plus haut ou le support mieux choisi en début de commande.',
    confidence: confidenceFor(orders.length),
  }
}

/** 6. Dépassement systématique des pauses. */
const breaks: Rule = (days) => {
  let taken = 0
  let over = 0
  let count = 0

  for (const day of days) {
    for (const segment of day.segments) {
      if (segment.deletedAt) continue
      if (segment.type !== 'break_10' && segment.type !== 'break_30') continue
      const quota = segment.type === 'break_10' ? 10 * MINUTE : 30 * MINUTE
      const duration = (segment.endedAt ?? segment.startedAt) - segment.startedAt
      taken += duration
      count += 1
      if (duration > quota) over += duration - quota
    }
  }

  if (count < MIN_SAMPLES || over < 5 * MINUTE) return undefined
  const perDay = over / days.length

  return {
    id: 'breaks',
    severity: perDay > 15 * MINUTE ? 'medium' : 'info',
    title: `Pauses dépassées de ${formatShort(perDay)} par vacation`,
    detail: `${formatShort(over)} de dépassement cumulé sur ${count} pauses, pour ${formatShort(taken)} de pause au total.`,
    action:
      "L'alerte de fin de pause est réglable dans les paramètres si tu veux qu'elle sonne plus tôt.",
    confidence: confidenceFor(count),
  }
}

/** 7. Régularité d'une commande à l'autre. */
const regularity: Rule = (days) => {
  const rates = allOrders(days)
    .filter((o) => o.colis >= 20 && isRateMeaningful(o.totalWorked))
    .map((o) => o.rateOrder)
  if (rates.length < MIN_SAMPLES + 1) return undefined

  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  if (mean <= 0) return undefined
  const variance = rates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / rates.length
  const deviation = Math.sqrt(variance)
  const ratio = deviation / mean
  if (ratio < 0.25) return undefined

  return {
    id: 'regularity',
    severity: 'info',
    title: 'Cadence très variable d’une commande à l’autre',
    detail: `Moyenne ${Math.round(mean)} colis/h, écart type ${Math.round(deviation)} — de ${Math.round(Math.min(...rates))} à ${Math.round(Math.max(...rates))}.`,
    action:
      'Regarde le détail des commandes les plus lentes dans l’historique : elles ont souvent un point commun (zone, densité, aléa).',
    confidence: confidenceFor(rates.length),
  }
}

/** 8. Ce qui sépare les meilleures des pires vacations. */
const bestVsWorst: Rule = (days) => {
  const result = spread(days)
  if (!result || result.gap < 10) return undefined

  const wasteBest =
    result.best.reduce((sum, d) => sum + d.metrics.wasteTime, 0) / result.best.length
  const wasteWorst =
    result.worst.reduce((sum, d) => sum + d.metrics.wasteTime, 0) / result.worst.length
  const diff = wasteWorst - wasteBest

  return {
    id: 'best-worst',
    severity: 'info',
    title: `${Math.round(result.gap)} colis/h entre tes meilleures et tes pires journées`,
    detail:
      diff > 5 * MINUTE
        ? `Les moins bonnes cumulent ${formatShort(diff)} de temps perdu en plus.`
        : `Le temps perdu est comparable des deux côtés : l'écart vient plutôt du contenu des commandes.`,
    action:
      diff > 5 * MINUTE
        ? 'Le levier est là : ce sont les aléas et les trajets qui font la différence, pas le rythme de prélèvement.'
        : 'Peu de marge sur l’organisation : les écarts semblent surtout subis.',
    confidence: confidenceFor(result.best.length + result.worst.length),
  }
}

/** 9. Aléas récurrents. */
const recurringIncidents: Rule = (days) => {
  if (days.length < 2) return undefined
  const incidents = losses(days, 110).filter((l) => l.type.startsWith('incident_'))
  const total = incidents.reduce((sum, l) => sum + l.count, 0)
  if (total < 3) return undefined

  const [worst] = incidents
  return {
    id: 'incidents',
    severity: worst.perDay >= 1 ? 'medium' : 'info',
    title: `${worst.emoji} ${worst.label} : ${worst.count} fois sur ${days.length} vacations`,
    detail: `${formatShort(worst.time)} au total, soit ${formatShort(worst.time / days.length)} par jour.`,
    action:
      'Ces temps ne dépendent pas de toi. Le relevé chiffré est ce qui permet de le montrer si ta cadence est discutée.',
    confidence: confidenceFor(days.length),
  }
}

/** 10. Position par rapport à l'objectif, en dernier recours. */
const versusTarget: Rule = (days, targetRate) => {
  const colis = days.reduce((sum, d) => sum + d.metrics.colis, 0)
  const worked = days.reduce((sum, d) => sum + d.metrics.worked, 0)
  if (!isRateMeaningful(worked)) return undefined

  const actual = rate(colis, worked)
  const delta = actual - targetRate

  return {
    id: 'target',
    severity: 'info',
    title:
      delta >= 0
        ? `Objectif tenu : ${Math.round(actual)} colis/h sur la période`
        : `${Math.round(-delta)} colis/h sous l'objectif`,
    detail: `${colis} colis pour ${formatShort(worked)} travaillés, hors pauses, sur ${days.length} vacation(s).`,
    action:
      delta >= 0
        ? 'Rien à corriger sur ce plan.'
        : `Il manque ${formatShort((Math.abs(delta) / targetRate) * HOUR)} de temps productif par heure travaillée pour atteindre ${targetRate}/h.`,
    confidence: confidenceFor(days.length),
  }
}

const RULES: Rule[] = [
  topLoss,
  fatigue,
  setupCost,
  density,
  palletChanges,
  breaks,
  regularity,
  bestVsWorst,
  recurringIncidents,
  versusTarget,
]
