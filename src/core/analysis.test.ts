import { describe, expect, it } from 'vitest'
import { byDensity, byHour, byOrderType, byWeekday, losses, spread } from './analysis'
import { makeDay } from './fixtures'
import { HOUR, MINUTE } from './time'

/**
 * Les analyses guident des décisions concrètes : autant vérifier qu'elles
 * calculent bien ce qu'elles annoncent, sur des journées construites à la main
 * dont on connaît le résultat attendu.
 */

describe('cadence par type de commande', () => {
  it('sépare les types et compte les observations', () => {
    const day = makeDay('2026-07-27', [
      { colis: 110, lines: 30, startHour: 13, pickingMinutes: 60, type: 'normale' },
      { colis: 55, lines: 20, startHour: 15, pickingMinutes: 60, type: 'urbaine' },
    ])

    const buckets = byOrderType([day])
    expect(buckets.map((b) => b.key)).toEqual(['normale', 'urbaine'])
    expect(buckets[0].rate).toBeCloseTo(110, 5)
    expect(buckets[1].rate).toBeCloseTo(55, 5)
    expect(buckets[0].samples).toBe(1)
  })
})

describe('cadence selon la densité', () => {
  it('range les commandes par colis/ligne et calcule sur le prélèvement seul', () => {
    const day = makeDay('2026-07-27', [
      // 100 colis sur 10 lignes = 10 colis/ligne, en 60 min
      { colis: 100, lines: 10, startHour: 13, pickingMinutes: 60 },
      // 60 colis sur 60 lignes = 1 colis/ligne, en 60 min
      { colis: 60, lines: 60, startHour: 15, pickingMinutes: 60 },
    ])

    const buckets = byDensity([day])
    const groupee = buckets.find((b) => b.key === 'groupee')
    const eclatee = buckets.find((b) => b.key === 'tres-eclatee')

    expect(groupee?.rate).toBeCloseTo(100, 5)
    expect(eclatee?.rate).toBeCloseTo(60, 5)
    // C'est bien la densité qui explique l'écart, pas un relâchement.
    expect(groupee!.rate).toBeGreaterThan(eclatee!.rate)
  })
})

describe('courbe horaire', () => {
  it('répartit les colis sur les heures effectivement travaillées', () => {
    const day = makeDay('2026-07-27', [
      { colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 },
      { colis: 50, lines: 25, startHour: 19, pickingMinutes: 60 },
    ])

    const points = byHour([day])
    const at13 = points.find((p) => p.hour === 13)
    const at19 = points.find((p) => p.hour === 19)

    expect(at13?.rate).toBeCloseTo(100, 5)
    expect(at19?.rate).toBeCloseTo(50, 5)
    // Le décrochage de fin de vacation doit ressortir.
    expect(at19!.rate).toBeLessThan(at13!.rate)
  })

  it('découpe un prélèvement à cheval sur deux heures', () => {
    const day = makeDay('2026-07-27', [
      { colis: 120, lines: 30, startHour: 13, pickingMinutes: 120 },
    ])
    const points = byHour([day])
    expect(points.map((p) => p.hour)).toEqual([13, 14])
    for (const point of points) {
      expect(point.pickingTime).toBe(HOUR)
      expect(point.colis).toBe(60)
    }
  })
})

describe('temps perdu', () => {
  it('classe les causes et les convertit en colis', () => {
    const day = makeDay('2026-07-27', [
      {
        colis: 100,
        lines: 25,
        startHour: 13,
        pickingMinutes: 60,
        waste: [
          { type: 'travel', minutes: 20 },
          { type: 'incident_material', minutes: 30 },
        ],
      },
    ])

    const lines = losses([day], 110)
    expect(lines[0].type).toBe('incident_material')
    expect(lines[0].time).toBe(30 * MINUTE)
    // 30 min à 110 colis/h = 55 colis manqués.
    expect(lines[0].colisEquivalent).toBeCloseTo(55, 5)
    expect(lines[1].type).toBe('travel')
  })

  it('ignore le changement de palette, qui est du travail nécessaire', () => {
    const day = makeDay('2026-07-27', [
      {
        colis: 100,
        lines: 25,
        startHour: 13,
        pickingMinutes: 60,
        waste: [{ type: 'pallet_change', minutes: 10 }],
      },
    ])
    expect(losses([day], 110)).toHaveLength(0)
  })
})

describe('jours de la semaine', () => {
  it('regroupe par jour et nomme correctement', () => {
    // 27 juillet 2026 = lundi, 28 = mardi
    const days = [
      makeDay('2026-07-27', [{ colis: 110, lines: 30, startHour: 13, pickingMinutes: 60 }]),
      makeDay('2026-07-28', [{ colis: 90, lines: 30, startHour: 13, pickingMinutes: 60 }]),
    ]
    const buckets = byWeekday(days)
    expect(buckets.map((b) => b.label)).toEqual(['Lundi', 'Mardi'])
  })
})

describe('meilleures et pires journées', () => {
  it('ne se prononce pas sous quatre vacations', () => {
    const days = [
      makeDay('2026-07-27', [{ colis: 110, lines: 30, startHour: 13, pickingMinutes: 60 }]),
      makeDay('2026-07-28', [{ colis: 90, lines: 30, startHour: 13, pickingMinutes: 60 }]),
    ]
    expect(spread(days)).toBeUndefined()
  })

  it('sépare le quart haut du quart bas', () => {
    const days = [130, 120, 110, 100, 90, 60].map((colis, i) =>
      makeDay(`2026-07-2${i + 1}`, [
        { colis, lines: 30, startHour: 13, pickingMinutes: 60 },
      ]),
    )
    const result = spread(days)
    expect(result).toBeDefined()
    expect(result!.bestRate).toBeGreaterThan(result!.worstRate)
    expect(result!.gap).toBeCloseTo(result!.bestRate - result!.worstRate, 5)
  })
})
