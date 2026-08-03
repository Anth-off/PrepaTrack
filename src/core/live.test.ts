import { describe, expect, it } from 'vitest'
import { computeLive } from './metrics'
import { MINUTE } from './time'
import type { ColisEvent, Order, Segment } from './types'
import { EMPTY_SUPPORTS } from './types'

/**
 * L'avance/retard est le chiffre regardé en pleine préparation. Il doit refléter
 * le temps réellement écoulé : une interruption pendant laquelle aucun colis
 * n'est prélevé fait prendre du retard à la commande, que la cause soit
 * imputable au préparateur ou non.
 */

const T = new Date(2026, 7, 6, 13, 0, 0).getTime()

const order: Order = {
  id: 'o1',
  workdayId: 'w1',
  status: 'open',
  orderType: 'normale',
  colisPlanned: 220,
  linesCount: 55,
  supports: { ...EMPTY_SUPPORTS },
  startedAt: T,
  updatedAt: T,
  syncState: 'synced',
}

function seg(type: string, from: number, minutes?: number): Segment {
  return {
    id: `${type}-${from}`,
    workdayId: 'w1',
    orderId: 'o1',
    type,
    startedAt: T + from * MINUTE,
    endedAt: minutes === undefined ? undefined : T + (from + minutes) * MINUTE,
    updatedAt: T,
    syncState: 'synced',
  }
}

function colis(count: number, at: number): ColisEvent {
  return {
    id: `e-${at}`,
    workdayId: 'w1',
    orderId: 'o1',
    at: T + at * MINUTE,
    delta: count,
    updatedAt: T,
    syncState: 'synced',
  }
}

describe('avance et retard en direct', () => {
  it('creuse le retard pendant un trajet', () => {
    // 110 colis prélevés en 60 min : pile à l'objectif de 110/h.
    const before = computeLive(
      order,
      [seg('picking', 0, 60)],
      [colis(110, 60)],
      110,
      T + 60 * MINUTE,
    )
    expect(Math.round(before.delta)).toBe(0)

    // Dix minutes de trajet plus tard, toujours 110 colis : 70 min écoulées,
    // on en attendait 128.
    const after = computeLive(
      order,
      [seg('picking', 0, 60), seg('travel', 60, 10)],
      [colis(110, 60)],
      110,
      T + 70 * MINUTE,
    )
    expect(Math.round(after.expected)).toBe(128)
    expect(Math.round(after.delta)).toBe(-18)
    expect(after.delta).toBeLessThan(before.delta)
  })

  it('creuse le retard pendant une attente, un aléa ou un passage aux toilettes', () => {
    for (const type of ['incident_wait', 'incident_material', 'toilet', 'custom_rupture']) {
      const live = computeLive(
        order,
        [seg('picking', 0, 60), seg(type, 60, 15)],
        [colis(110, 60)],
        110,
        T + 75 * MINUTE,
      )
      // Aucun colis pendant ces minutes : la commande prend du retard, même si
      // la cause ne dépend pas du préparateur.
      expect(Math.round(live.delta), type).toBe(-27)
    }
  })

  it('creuse le retard pendant un changement de palette', () => {
    const live = computeLive(
      order,
      [seg('picking', 0, 60), seg('pallet_change', 60, 6)],
      [colis(110, 60)],
      110,
      T + 66 * MINUTE,
    )
    expect(Math.round(live.delta)).toBe(-11)
  })

  it('creuse le retard pendant un filmage intermédiaire', () => {
    const live = computeLive(
      order,
      [seg('picking', 0, 60), seg('wrapping', 60, 6)],
      [colis(110, 60)],
      110,
      T + 66 * MINUTE,
    )
    expect(Math.round(live.delta)).toBe(-11)
  })

  it('ne pénalise pas les pauses réglementaires', () => {
    const live = computeLive(
      order,
      [seg('picking', 0, 60), seg('break_30', 60, 30)],
      [colis(110, 60)],
      110,
      T + 90 * MINUTE,
    )
    // Une pause est un arrêt de travail, pas du temps perdu sur la commande.
    expect(Math.round(live.delta)).toBe(0)
    expect(Math.round(live.expected)).toBe(110)
  })

  it('reprend son cours après la fin de l’interruption', () => {
    const segments = [seg('picking', 0, 60), seg('travel', 60, 10), seg('picking', 70, 30)]
    // 100 min écoulées, 200 colis : on en attendait 183.
    const live = computeLive(order, segments, [colis(200, 100)], 110, T + 100 * MINUTE)
    expect(Math.round(live.expected)).toBe(183)
    expect(Math.round(live.delta)).toBe(17)
  })

  it('ne compte rien tant que le prélèvement n’a pas commencé', () => {
    const live = computeLive(order, [seg('order_setup', 0, 8)], [], 110, T + 8 * MINUTE)
    // La recherche de palette ne doit pas creuser un retard avant même d'avoir
    // commencé à prélever.
    expect(live.expected).toBe(0)
    expect(live.delta).toBe(0)
  })
})
