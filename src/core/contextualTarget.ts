import type { DayData } from './analysis'
import { DENSITY_BUCKETS } from './analysis'
import { isRateMeaningful } from './metrics'
import type { OrderType, Supports, SupportKind } from './types'

export const MIN_CONTEXT_SAMPLES = 3

const TYPE_LABELS: Record<OrderType, string> = {
  normale: 'normale',
  urbaine: 'urbaine',
  geprocor: 'Geprocor',
}

const SUPPORT_LABELS: Record<SupportKind, string> = {
  ipp: 'IPP',
  europe: 'Europe',
  vrac: 'vrac',
  vmax: 'VMAX',
  demi: 'demi-palette',
  perdue: 'palette perdue',
}

export interface TargetContextInput {
  orderType: OrderType
  colis: number
  linesCount: number
  /** Absent pendant la préparation, puisque les supports sont saisis à la fin. */
  supports?: Supports
}

export interface ContextualTarget {
  rate: number
  source: 'personal-history' | 'manual'
  method: 'median' | 'manual'
  samples: number
  minimumSamples: number
  context: string
  explanation: string
}

interface ComparableContext {
  orderType: OrderType
  densityKey?: string
  densityLabel: string
  supportKey?: string
  supportLabel?: string
}

function densityContext(colis: number, linesCount: number) {
  if (colis <= 0 || linesCount <= 0) return { key: undefined, label: 'densité inconnue' }
  const density = colis / linesCount
  const bucket = DENSITY_BUCKETS.find((item) => density < item.max) ?? DENSITY_BUCKETS.at(-1)!
  return { key: bucket.key, label: bucket.label.toLowerCase() }
}

function supportContext(supports?: Supports) {
  if (!supports) return undefined
  const entries = (Object.entries(supports) as [SupportKind, number][])
    .filter(([, count]) => count > 0)
    .sort(([kindA], [kindB]) => kindA.localeCompare(kindB))
  if (entries.length === 0) return undefined

  return {
    key: entries.map(([kind, count]) => `${kind}:${count}`).join('|'),
    label: entries.map(([kind, count]) => `${count} ${SUPPORT_LABELS[kind]}`).join(' + '),
  }
}

function comparableContext(input: TargetContextInput): ComparableContext {
  const density = densityContext(input.colis, input.linesCount)
  const support = supportContext(input.supports)
  return {
    orderType: input.orderType,
    densityKey: density.key,
    densityLabel: density.label,
    supportKey: support?.key,
    supportLabel: support?.label,
  }
}

function contextLabel(context: ComparableContext): string {
  return [TYPE_LABELS[context.orderType], context.densityLabel, context.supportLabel]
    .filter(Boolean)
    .join(' · ')
}

/** Médiane déterministe. Elle maîtrise les valeurs extrêmes sans seuil arbitraire. */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

/** Calcule l'objectif uniquement depuis l'historique personnel local fourni. */
export function contextualTarget(
  days: DayData[],
  input: TargetContextInput,
  manualRate: number,
): ContextualTarget {
  const wanted = comparableContext(input)
  const rates: number[] = []

  if (wanted.densityKey) {
    for (const day of days) {
      for (const metrics of day.metrics.orders) {
        const order = metrics.order
        if (order.status !== 'done' || order.deletedAt || order.orderType !== wanted.orderType) continue
        if (!isRateMeaningful(metrics.picking) || metrics.ratePicking <= 0) continue

        const candidate = comparableContext({
          orderType: order.orderType,
          colis: metrics.colis,
          linesCount: order.linesCount,
          supports: wanted.supportKey ? order.supports : undefined,
        })
        if (candidate.densityKey !== wanted.densityKey) continue
        if (wanted.supportKey && candidate.supportKey !== wanted.supportKey) continue
        rates.push(metrics.ratePicking)
      }
    }
  }

  const context = contextLabel(wanted)
  if (rates.length < MIN_CONTEXT_SAMPLES) {
    return {
      rate: manualRate,
      source: 'manual',
      method: 'manual',
      samples: rates.length,
      minimumSamples: MIN_CONTEXT_SAMPLES,
      context,
      explanation: wanted.densityKey
        ? `Objectif manuel : ${rates.length}/${MIN_CONTEXT_SAMPLES} commandes comparables.`
        : 'Objectif manuel : renseigne les lignes pour comparer la densité.',
    }
  }

  return {
    rate: median(rates),
    source: 'personal-history',
    method: 'median',
    samples: rates.length,
    minimumSamples: MIN_CONTEXT_SAMPLES,
    context,
    explanation: `Médiane de ${rates.length} commandes comparables de ton historique.`,
  }
}
