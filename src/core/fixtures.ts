import type { DayData } from './analysis'
import type { Snapshot } from './machine'
import { computeDayMetrics } from './metrics'
import { MINUTE } from './time'
import type { ColisEvent, Order, OrderType, Segment, SegmentType, Workday } from './types'
import { EMPTY_SUPPORTS } from './types'

/**
 * Fabrique de vacations pour les tests. N'est importé par aucun écran, donc
 * jamais embarqué dans l'application. Construire des journées dont on connaît
 * les durées exactes est le seul moyen de vérifier des analyses dont les
 * résultats seraient sinon invérifiables à l'œil.
 */

let seq = 0
const uid = () => `fixture-${seq++}`

export interface OrderSpec {
  colis: number
  lines: number
  type?: OrderType
  /** Heure de début du prélèvement, en heures locales. */
  startHour: number
  /** Durée du prélèvement, en minutes. */
  pickingMinutes: number
  /** Segments improductifs intercalés après le prélèvement. */
  waste?: { type: SegmentType; minutes: number }[]
  /** Durée de la recherche de palette, en minutes. */
  setupMinutes?: number
}

export function makeDay(
  date: string,
  specs: OrderSpec[],
  targetRate = 110,
  ownerId?: string,
): DayData {
  const [y, m, d] = date.split('-').map(Number)
  const workdayId = uid()
  const segments: Segment[] = []
  const orders: Order[] = []
  const events: ColisEvent[] = []

  const push = (
    orderId: string,
    type: SegmentType,
    startedAt: number,
    minutes: number,
  ): number => {
    const endedAt = startedAt + minutes * MINUTE
    segments.push({
      id: uid(),
      workdayId,
      orderId,
      type,
      startedAt,
      endedAt,
      updatedAt: startedAt,
      syncState: 'synced',
      ownerId,
    })
    return endedAt
  }

  for (const spec of specs) {
    const orderId = uid()
    const orderStart = new Date(y, m - 1, d, spec.startHour, 0, 0).getTime()
    let cursor = orderStart

    if (spec.setupMinutes) cursor = push(orderId, 'order_setup', cursor, spec.setupMinutes)
    const pickingStart = cursor
    cursor = push(orderId, 'picking', cursor, spec.pickingMinutes)
    for (const w of spec.waste ?? []) cursor = push(orderId, w.type, cursor, w.minutes)

    orders.push({
      id: orderId,
      workdayId,
      status: 'done',
      orderType: spec.type ?? 'normale',
      colisPlanned: spec.colis,
      linesCount: spec.lines,
      colisActual: spec.colis,
      supports: { ...EMPTY_SUPPORTS, europe: 1 },
      startedAt: orderStart,
      endedAt: cursor,
      updatedAt: orderStart,
      syncState: 'synced',
      ownerId,
    })

    void pickingStart
  }

  segments.sort((a, b) => a.startedAt - b.startedAt)

  const workday: Workday = {
    id: workdayId,
    date,
    status: 'closed',
    startedAt: segments[0].startedAt,
    endedAt: segments[segments.length - 1].endedAt,
    updatedAt: 0,
    syncState: 'synced',
    ownerId,
  }

  const snap: Snapshot = { workday, segments, orders }
  return {
    id: workdayId,
    date,
    segments,
    events,
    metrics: computeDayMetrics(snap, events, targetRate, workday.endedAt),
  }
}
