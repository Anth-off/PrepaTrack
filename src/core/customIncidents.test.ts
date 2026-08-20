import { beforeEach, describe, expect, it } from 'vitest'
import { losses } from './analysis'
import { computeDayMetrics } from './metrics'
import {
  categoryOf,
  INCIDENT_TYPES,
  isInterruption,
  listedIncidentTypes,
  registerCustomIncidents,
  segmentDef,
} from './segments'
import type { Snapshot } from './machine'
import type { Segment } from './types'

/**
 * Un aléa personnalisé traverse toute l'application : boutons, frise, bilan,
 * analyses. Le risque n'est pas un libellé manquant mais un écran blanc, car
 * `SEGMENTS[type]` renvoyait `undefined` pour un type inconnu.
 */

const T = new Date(2026, 7, 3, 13, 0, 0).getTime()

beforeEach(() => {
  registerCustomIncidents([])
})

function seg(type: string, minutes: number, startedAt = T): Segment {
  return {
    id: `s-${type}-${startedAt}`,
    workdayId: 'w1',
    type,
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    updatedAt: startedAt,
    syncState: 'synced',
  }
}

describe('résolution des types de segments', () => {
  it('résout les types livrés', () => {
    expect(segmentDef('picking').label).toBe('Préparation')
    expect(segmentDef('break_30').category).toBe('break')
  })

  it('propose les aléas métier canoniques, y compris chef, collègue et VMAX', () => {
    expect(INCIDENT_TYPES).toEqual([
      'incident_material',
      'incident_bug',
      'incident_discussion',
      'incident_forklift',
      'incident_drink',
      'incident_label',
      'incident_supplies',
      'incident_restock_wait',
      'incident_manager',
      'incident_colleague',
      'incident_vmax',
      'incident_wait',
      'incident_aisle',
      'incident_search',
      'incident_wms',
      'incident_quality',
    ])
    expect(INCIDENT_TYPES.map((type) => segmentDef(type).short)).toEqual([
      'Matériel',
      'Bug',
      'Discussion',
      'Cariste',
      'Boire',
      'Étiquette',
      'Consommables',
      'Réappro',
      'Chef',
      'Collègue',
      'VMAX',
      'Attente',
      'Allée',
      'Emplacement',
      'WMS',
      'Qualité',
    ])
  })

  it('ne renvoie jamais undefined sur un type inconnu', () => {
    const def = segmentDef('type_qui_nexiste_pas')
    // C'est ce contrat qui empêche l'écran de bilan de planter sur une journée
    // où un aléa depuis supprimé avait servi.
    expect(def).toBeDefined()
    expect(typeof def.label).toBe('string')
    expect(def.category).toBe('waste')
    expect(def.interruption).toBe(true)
  })

  it('résout un aléa enregistré avec son libellé', () => {
    registerCustomIncidents([{ key: 'custom_abc', label: 'Rupture', emoji: '🚫' }])
    expect(segmentDef('custom_abc').label).toBe('Rupture')
    expect(segmentDef('custom_abc').emoji).toBe('🚫')
    expect(isInterruption('custom_abc')).toBe(true)
    expect(categoryOf('custom_abc')).toBe('waste')
    expect(listedIncidentTypes()).toContain('custom_abc')
  })

  it('refuse de laisser redéfinir un type livré', () => {
    registerCustomIncidents([{ key: 'picking', label: 'Détourné', emoji: '😈' }])
    // Autoriser cela permettrait de reclasser le prélèvement en temps perdu.
    expect(segmentDef('picking').label).toBe('Préparation')
    expect(segmentDef('picking').category).toBe('productive')
  })

  it('garde un libellé lisible après suppression de l’aléa', () => {
    registerCustomIncidents([{ key: 'custom_abc', label: 'Rupture', emoji: '🚫' }])
    expect(segmentDef('custom_abc').label).toBe('Rupture')

    registerCustomIncidents([])
    const def = segmentDef('custom_abc')
    expect(def.label).toBe('Aléa supprimé')
    expect(def.category).toBe('waste')
  })
})

describe('prise en compte dans les calculs', () => {
  it('compte un aléa personnalisé comme du temps perdu', () => {
    registerCustomIncidents([{ key: 'custom_abc', label: 'Rupture', emoji: '🚫' }])

    const segments = [
      seg('picking', 60, T),
      seg('custom_abc', 15, T + 60 * 60_000),
      seg('picking', 30, T + 75 * 60_000),
    ]
    const snap: Snapshot = {
      workday: {
        id: 'w1',
        date: '2026-08-03',
        status: 'closed',
        startedAt: T,
        endedAt: T + 105 * 60_000,
        updatedAt: T,
        syncState: 'synced',
      },
      segments,
      orders: [],
    }

    const metrics = computeDayMetrics(snap, [], 110, T + 105 * 60_000)
    expect(metrics.wasteTime).toBe(15 * 60_000)
    expect(metrics.pickingTime).toBe(90 * 60_000)
    // Le temps perdu doit rester exclu du temps de prélèvement.
    expect(metrics.presence).toBe(105 * 60_000)
  })

  it('fait apparaître l’aléa personnalisé dans le détail du temps perdu', () => {
    registerCustomIncidents([{ key: 'custom_abc', label: 'Rupture', emoji: '🚫' }])

    const day = {
      id: 'w1',
      date: '2026-08-03',
      segments: [seg('custom_abc', 20, T), seg('travel', 10, T + 20 * 60_000)],
      events: [],
      metrics: computeDayMetrics(
        {
          workday: {
            id: 'w1',
            date: '2026-08-03',
            status: 'closed',
            startedAt: T,
            endedAt: T + 30 * 60_000,
            updatedAt: T,
            syncState: 'synced' as const,
          },
          segments: [seg('custom_abc', 20, T), seg('travel', 10, T + 20 * 60_000)],
          orders: [],
        },
        [],
        110,
        T + 30 * 60_000,
      ),
    }

    const lines = losses([day], 110)
    const rupture = lines.find((l) => l.type === 'custom_abc')
    expect(rupture?.label).toBe('Rupture')
    expect(rupture?.time).toBe(20 * 60_000)
    // 20 minutes à 110/h valent une quarantaine de colis.
    expect(Math.round(rupture!.colisEquivalent)).toBe(37)
  })
})
