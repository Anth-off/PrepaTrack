import { describe, expect, it } from 'vitest'
import { pickingGaps, delaySignal, buildDiagnosis } from './coaching'
import type { ColisEvent, Segment } from './types'
import { dailyProductionStatus } from './productionPlan'

const MIN = 60_000
const base = new Date(2026, 7, 24, 13, 20).getTime()
const sync = { updatedAt: base, syncState: 'synced' as const }

function event(id: string, at: number, delta = 1): ColisEvent {
  return { id, workdayId: 'd', orderId: 'o', at, delta, ...sync }
}

function segment(id: string, type: string, startedAt: number, endedAt?: number): Segment {
  return { id, workdayId: 'd', orderId: 'o', type, startedAt, endedAt, ...sync }
}

describe('intervalles de picking du coach', () => {
  it('retire entièrement les trajets entre deux comptages', () => {
    const gaps = pickingGaps('o', [event('a', base), event('b', base + 5 * MIN)], [
      segment('p1', 'picking', base, base + 2 * MIN),
      segment('t', 'travel', base + 2 * MIN, base + 4 * MIN),
      segment('p2', 'picking', base + 4 * MIN, base + 5 * MIN),
    ])
    expect(gaps[0].activeMs).toBe(3 * MIN)
  })

  it('normalise un appui +10 par colis', () => {
    const gaps = pickingGaps('o', [event('a', base), event('b', base + 100_000, 10)], [
      segment('p', 'picking', base, base + 100_000),
    ])
    expect(gaps[0].msPerPackage).toBe(10_000)
  })
})

describe('retard confirmé', () => {
  it('détecte un écart quotidien important', () => {
    const production = dailyProductionStatus('2026-08-24', 0, base + 30 * MIN)
    const signal = delaySignal({ snap: { segments: [], orders: [] }, events: [], shortages: [], history: [], production, targetRate: 110, now: base + 30 * MIN })
    expect(signal.delayed).toBe(true)
    expect(signal.packages).toBeGreaterThanOrEqual(15)
  })

  it('attribue un retard à un trajet récent sans le confondre avec le picking', () => {
    const now = base + 20 * MIN
    const snap = {
      workday: { id: 'd', date: '2026-08-24', status: 'open' as const, startedAt: base, ...sync },
      orders: [],
      segments: [segment('t', 'travel', now - 6 * MIN, now)],
    }
    const diagnosis = buildDiagnosis(
      { snap, events: [], shortages: [], history: [], targetRate: 110, now },
      { delayed: true, packages: 18, reason: 'daily', confirmationMs: 5 * MIN },
    )
    expect(diagnosis?.cause).toBe('travel')
    expect(diagnosis?.evidence[0].value).toBe(6)
  })

  it('ne produit rien pendant une pause réglementaire', () => {
    const now = base + 20 * MIN
    const snap = { orders: [], segments: [segment('b', 'break_10', now - MIN)] }
    expect(buildDiagnosis(
      { snap, events: [], shortages: [], history: [], targetRate: 110, now },
      { delayed: true, packages: 30, reason: 'daily', confirmationMs: 5 * MIN },
    )).toBeUndefined()
  })
})
