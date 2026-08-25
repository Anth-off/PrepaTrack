import { describe, expect, it } from 'vitest'
import type { Snapshot } from './machine'
import { inspectIntegrity, type IntegrityRule } from './integrity'
import { dayKey, MINUTE } from './time'
import type { ColisEvent, Order, Segment, StockShortage, Workday } from './types'
import { DEFAULT_SETTINGS, EMPTY_SUPPORTS } from './types'

const T = new Date(2026, 7, 4, 8, 0, 0).getTime()

function workday(over: Partial<Workday> = {}): Workday {
  return {
    id: 'w1', date: dayKey(T), status: 'closed', startedAt: T, endedAt: T + 60 * MINUTE,
    updatedAt: T, syncState: 'synced', ...over,
  }
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: 'o1', workdayId: 'w1', status: 'done', orderType: 'normale', colisPlanned: 20,
    colisActual: 20, linesCount: 10, supports: { ...EMPTY_SUPPORTS }, startedAt: T,
    endedAt: T + 20 * MINUTE, updatedAt: T, syncState: 'synced', ...over,
  }
}

function segment(over: Partial<Segment> = {}): Segment {
  return {
    id: 's1', workdayId: 'w1', orderId: 'o1', type: 'picking', startedAt: T,
    endedAt: T + 10 * MINUTE, updatedAt: T, syncState: 'synced', ...over,
  }
}

function event(over: Partial<ColisEvent> = {}): ColisEvent {
  return {
    id: 'e1', workdayId: 'w1', orderId: 'o1', at: T, delta: 1,
    updatedAt: T, syncState: 'synced', ...over,
  }
}

function shortage(over: Partial<StockShortage> = {}): StockShortage {
  return {
    id: 'r1', workdayId: 'w1', orderId: 'o1', at: T, quantity: 1, resolved: false,
    updatedAt: T, syncState: 'synced', ...over,
  }
}

function inspect(
  snap: Snapshot,
  events: ColisEvent[] = [],
  shortages: StockShortage[] = [],
  now = T + 60 * MINUTE,
) {
  return inspectIntegrity({ snap, events, shortages, settings: DEFAULT_SETTINGS, now })
}

function has(rule: IntegrityRule, issues: ReturnType<typeof inspect>): boolean {
  return issues.some((item) => item.rule === rule)
}

describe('contrôles d’intégrité locaux', () => {
  it('signale uniquement un chrono qui dépasse son seuil', () => {
    const long = segment({ endedAt: undefined, startedAt: T })
    expect(has('stuck_timer', inspect({ workday: workday({ status: 'open', endedAt: undefined }), orders: [], segments: [long] }, [], [], T + 151 * MINUTE))).toBe(true)
    expect(has('stuck_timer', inspect({ workday: workday({ status: 'open', endedAt: undefined }), orders: [], segments: [long] }, [], [], T + 60 * MINUTE))).toBe(false)
  })

  it('signale une vacation ouverte le lendemain, mais pas une vacation close', () => {
    const tomorrow = T + 24 * 60 * MINUTE
    expect(has('stale_workday', inspect({ workday: workday({ status: 'open', endedAt: undefined }), orders: [], segments: [] }, [], [], tomorrow))).toBe(true)
    expect(has('stale_workday', inspect({ workday: workday(), orders: [], segments: [] }, [], [], tomorrow))).toBe(false)
  })

  it('distingue un écart inexpliqué d’une rupture qui explique le compte', () => {
    const snap = { workday: workday(), orders: [order({ colisActual: 18 })], segments: [] }
    expect(has('unexplained_count', inspect(snap))).toBe(true)
    expect(has('unexplained_count', inspect(snap, [], [shortage({ quantity: 2 })]))).toBe(false)
    expect(has('unexplained_count', inspect({ ...snap, orders: [order({ colisActual: 22 })] }))).toBe(true)
  })

  it('signale les phases finales absentes, pas une commande complète', () => {
    const incomplete = [segment()]
    const complete = [
      segment(),
      segment({ id: 's2', type: 'wrapping', startedAt: T + 10 * MINUTE, endedAt: T + 15 * MINUTE }),
      segment({ id: 's3', type: 'docking', startedAt: T + 15 * MINUTE, endedAt: T + 20 * MINUTE }),
    ]
    expect(has('missing_order_phase', inspect({ workday: workday(), orders: [order()], segments: incomplete }))).toBe(true)
    expect(has('missing_order_phase', inspect({ workday: workday(), orders: [order()], segments: complete }))).toBe(false)
  })

  it('refuse un support négatif et accepte zéro', () => {
    expect(has('negative_supports', inspect({ workday: workday(), orders: [order({ status: 'open', supports: { ...EMPTY_SUPPORTS, ipp: -1 } })], segments: [] }))).toBe(true)
    expect(has('negative_supports', inspect({ workday: workday(), orders: [order()], segments: [] }))).toBe(false)
  })

  it('détecte un trou, mais pas une timeline continue', () => {
    const first = segment({ endedAt: T + 5 * MINUTE })
    const gap = segment({ id: 's2', startedAt: T + 6 * MINUTE, endedAt: T + 10 * MINUTE })
    const continuous = { ...gap, startedAt: T + 5 * MINUTE }
    expect(has('invalid_timeline', inspect({ workday: workday(), orders: [], segments: [first, gap] }))).toBe(true)
    expect(has('invalid_timeline', inspect({ workday: workday(), orders: [], segments: [first, continuous] }))).toBe(false)
  })

  it('signale seulement une cadence au-dessus du plafond technique', () => {
    const phases = [
      segment({ endedAt: T + 5 * MINUTE }),
      segment({ id: 's2', type: 'wrapping', startedAt: T + 5 * MINUTE, endedAt: T + 5 * MINUTE }),
      segment({ id: 's3', type: 'docking', startedAt: T + 5 * MINUTE, endedAt: T + 5 * MINUTE }),
    ]
    expect(has('impossible_rate', inspect({ workday: workday(), orders: [order({ colisActual: 100 })], segments: phases }))).toBe(true)
    expect(has('impossible_rate', inspect({ workday: workday(), orders: [order({ colisActual: 50 })], segments: phases }))).toBe(false)
  })

  it('détecte un doublon proche et ignore deux commandes distinctes', () => {
    const duplicate = order({ id: 'o2', startedAt: T + 2_000 })
    const distinct = order({ id: 'o2', startedAt: T + 10 * MINUTE })
    expect(has('probable_duplicate', inspect({ workday: workday(), orders: [order(), duplicate], segments: [] }))).toBe(true)
    expect(has('probable_duplicate', inspect({ workday: workday(), orders: [order(), distinct], segments: [] }))).toBe(false)
  })

  it('signale une rupture qui dépasse le prévu, pas un bilan réconcilié', () => {
    const snap = { workday: workday(), orders: [order({ colisActual: 20 })], segments: [] }
    expect(has('shortage_mismatch', inspect(snap, [], [shortage({ quantity: 1 })]))).toBe(true)
    expect(has('shortage_mismatch', inspect({ ...snap, orders: [order({ colisActual: 19 })] }, [], [shortage({ quantity: 1 })]))).toBe(false)
  })

  it('rend un identifiant stable et un fingerprint sensible aux modifications', () => {
    const snap = { workday: workday(), orders: [order({ colisActual: 18 })], segments: [] }
    const first = inspect(snap).find((item) => item.rule === 'unexplained_count')!
    const changed = inspect({ ...snap, orders: [order({ colisActual: 18, updatedAt: T + 1 })] }).find((item) => item.rule === 'unexplained_count')!
    expect(changed.id).toBe(first.id)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
  })

  it('détecte une durée négative et plusieurs segments ouverts', () => {
    const negative = segment({ endedAt: T - 1 })
    expect(has('invalid_timeline', inspect({ workday: workday(), orders: [], segments: [negative] }))).toBe(true)
    const open = [segment({ endedAt: undefined }), segment({ id: 's2', endedAt: undefined, startedAt: T + MINUTE })]
    expect(inspect({ workday: workday(), orders: [], segments: open }).filter((item) => item.rule === 'invalid_timeline').some((item) => item.title.includes('Plusieurs'))).toBe(true)
  })

  it('détecte aussi les doublons exacts de compteur et les ruptures orphelines', () => {
    const events = [event(), event({ id: 'e2' })]
    expect(has('probable_duplicate', inspect({ workday: workday(), orders: [order()], segments: [] }, events))).toBe(true)
    expect(has('shortage_mismatch', inspect({ workday: workday(), orders: [], segments: [] }, [], [shortage()]))).toBe(true)
  })

  it('ne confond pas deux appuis rapides ou deux palettes avec un doublon', () => {
    const rapid = [event(), event({ id: 'e2', at: T + 100 })]
    const pallets = [event({ palletId: 'p1' }), event({ id: 'e2', palletId: 'p2' })]
    const snap = { workday: workday(), orders: [order()], segments: [] }
    expect(has('probable_duplicate', inspect(snap, rapid))).toBe(false)
    expect(has('probable_duplicate', inspect(snap, pallets))).toBe(false)
  })
})
