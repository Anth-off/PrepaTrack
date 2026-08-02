import { describe, expect, it } from 'vitest'
import { computeOrderMetrics, isImposed, phaseElapsed } from './metrics'
import { MINUTE } from './time'
import type { Order, Segment } from './types'
import { EMPTY_SUPPORTS } from './types'

const T = new Date(2026, 7, 5, 13, 0, 0).getTime()

function seg(type: string, from: number, minutes: number, orderId = 'o1'): Segment {
  return {
    id: `${type}-${from}`,
    workdayId: 'w1',
    orderId,
    type,
    startedAt: T + from * MINUTE,
    endedAt: T + (from + minutes) * MINUTE,
    updatedAt: T,
    syncState: 'synced',
  }
}

const order: Order = {
  id: 'o1',
  workdayId: 'w1',
  status: 'done',
  orderType: 'normale',
  colisPlanned: 100,
  linesCount: 25,
  colisActual: 100,
  supports: { ...EMPTY_SUPPORTS, europe: 2, perdue: 1 },
  startedAt: T,
  endedAt: T + 90 * MINUTE,
  updatedAt: T,
  syncState: 'synced',
}

describe('temps subi', () => {
  it('reconnaît les aléas et les changements de palette', () => {
    expect(isImposed('pallet_change')).toBe(true)
    expect(isImposed('incident_material')).toBe(true)
    expect(isImposed('incident_wait')).toBe(true)
    // Les aléas ajoutés par l'utilisateur relèvent de la même logique.
    expect(isImposed('custom_abc')).toBe(true)

    // Trajets et passages aux toilettes restent comptés : ils font partie du
    // déroulement et se réduisent par l'organisation.
    expect(isImposed('travel')).toBe(false)
    expect(isImposed('toilet')).toBe(false)
    expect(isImposed('picking')).toBe(false)
  })

  it('ne fait pas baisser la cadence quand la palette est à changer', () => {
    const withChange = computeOrderMetrics(
      order,
      [
        seg('order_setup', 0, 5),
        seg('picking', 5, 50),
        seg('pallet_change', 55, 10),
        seg('picking', 65, 10),
        seg('wrapping', 75, 5),
        seg('docking', 80, 5),
      ],
      [],
      T + 85 * MINUTE,
    )

    const withoutChange = computeOrderMetrics(
      order,
      [
        seg('order_setup', 0, 5),
        seg('picking', 5, 60),
        seg('wrapping', 65, 5),
        seg('docking', 70, 5),
      ],
      [],
      T + 75 * MINUTE,
    )

    expect(withChange.imposed).toBe(10 * MINUTE)
    // Même travail, même temps de prélèvement : la cadence doit être identique,
    // que la palette ait dû être changée ou non.
    expect(withChange.picking).toBe(withoutChange.picking)
    expect(withChange.totalWorked).toBe(withoutChange.totalWorked)
    expect(withChange.rateOrder).toBeCloseTo(withoutChange.rateOrder, 6)
  })

  it('continue de compter les trajets', () => {
    const m = computeOrderMetrics(
      order,
      [seg('picking', 0, 50), seg('travel', 50, 10), seg('picking', 60, 10)],
      [],
      T + 70 * MINUTE,
    )
    expect(m.imposed).toBe(0)
    expect(m.totalWorked).toBe(70 * MINUTE)
  })
})

describe('cumul d’une phase', () => {
  it('additionne les segments séparés par une interruption', () => {
    const segments = [
      seg('picking', 0, 20),
      seg('travel', 20, 5),
      seg('picking', 25, 15),
      seg('pallet_change', 40, 4),
      seg('picking', 44, 11),
    ]

    const phase = phaseElapsed(segments, 'picking', 'o1', T + 55 * MINUTE)
    // 20 + 15 + 11 : c'est ce que l'écran doit afficher, pas les 11 dernières
    // minutes du segment courant.
    expect(phase.elapsed).toBe(46 * MINUTE)
    // Et l'heure affichée reste celle du tout début de la préparation.
    expect(phase.since).toBe(T)
  })

  it('ne mélange pas les commandes', () => {
    const segments = [seg('picking', 0, 30, 'o1'), seg('picking', 30, 20, 'o2')]
    expect(phaseElapsed(segments, 'picking', 'o1', T + 50 * MINUTE).elapsed).toBe(30 * MINUTE)
    expect(phaseElapsed(segments, 'picking', 'o2', T + 50 * MINUTE).elapsed).toBe(20 * MINUTE)
  })

  it('renvoie zéro sans segment correspondant', () => {
    expect(phaseElapsed([], 'picking', 'o1', T).elapsed).toBe(0)
  })
})
