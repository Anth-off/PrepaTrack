import { describe, expect, it } from 'vitest'
import { performanceByOwner, referenceRates } from './analysis'
import { makeDay } from './fixtures'

/**
 * Ces tests portent sur le seul chiffre de l'application qui puisse être opposé
 * à quelqu'un lors d'un entretien. Une erreur ici ne produit pas un affichage
 * bancal : elle produit un classement injuste.
 */

describe('cadences de référence', () => {
  it('sépare les commandes groupées des commandes éclatées', () => {
    const days = [
      // 120 colis sur 12 lignes = 10 colis/ligne, en 60 min -> 120/h
      makeDay('2026-08-03', [{ colis: 120, lines: 12, startHour: 13, pickingMinutes: 60 }]),
      // 60 colis sur 60 lignes = 1 colis/ligne, en 60 min -> 60/h
      makeDay('2026-08-04', [{ colis: 60, lines: 60, startHour: 13, pickingMinutes: 60 }]),
    ]

    const reference = referenceRates(days)
    const grouped = reference.find((b) => b.key === 'groupee')
    const scattered = reference.find((b) => b.key === 'tres-eclatee')

    expect(grouped?.rate).toBeCloseTo(120, 4)
    expect(scattered?.rate).toBeCloseTo(60, 4)
  })
})

describe('performance à densité égale', () => {
  it('départage deux préparateurs de même cadence brute mais de commandes différentes', () => {
    // Anthony ne reçoit que des commandes éclatées, Bruno que des groupées.
    // Tous deux sortent 90 colis/h bruts : à cadence brute, ils sont à égalité.
    const days = [
      makeDay(
        '2026-08-03',
        [{ colis: 90, lines: 90, startHour: 13, pickingMinutes: 60 }],
        110,
        'anthony',
      ),
      makeDay(
        '2026-08-03',
        [{ colis: 90, lines: 9, startHour: 13, pickingMinutes: 60 }],
        110,
        'bruno',
      ),
      // Deux journées de référence pour asseoir l'étalon de chaque tranche.
      makeDay(
        '2026-08-04',
        [{ colis: 60, lines: 60, startHour: 13, pickingMinutes: 60 }],
        110,
        'reference',
      ),
      makeDay(
        '2026-08-04',
        [{ colis: 150, lines: 15, startHour: 13, pickingMinutes: 60 }],
        110,
        'reference',
      ),
    ]

    const perf = performanceByOwner(days)
    const anthony = perf.find((p) => p.ownerId === 'anthony')!
    const bruno = perf.find((p) => p.ownerId === 'bruno')!

    // Cadence brute identique...
    expect(anthony.observedRate).toBeCloseTo(90, 4)
    expect(bruno.observedRate).toBeCloseTo(90, 4)

    // ...mais on n'attend pas la même chose d'eux.
    expect(anthony.expectedRate).toBeLessThan(bruno.expectedRate)

    // Anthony dépasse ce qu'on attend sur des commandes éclatées, Bruno non.
    expect(anthony.delta).toBeGreaterThan(0)
    expect(bruno.delta).toBeLessThan(0)
    // Le classement s'établit sur l'écart, pas sur la cadence brute.
    expect(perf[0].ownerId).toBe('anthony')
  })

  it('agrège par le temps et non par la moyenne des cadences', () => {
    // Une petite commande rapide et une grosse commande lente, même densité.
    // La moyenne arithmétique des cadences donnerait (200 + 50) / 2 = 125,
    // alors que la vraie cadence d'ensemble est bien plus basse.
    const days = [
      makeDay(
        '2026-08-03',
        [
          { colis: 20, lines: 5, startHour: 13, pickingMinutes: 6 }, // 200/h
          { colis: 100, lines: 25, startHour: 15, pickingMinutes: 120 }, // 50/h
        ],
        110,
        'anthony',
      ),
    ]

    const perf = performanceByOwner(days)
    const anthony = perf.find((p) => p.ownerId === 'anthony')!

    // 120 colis en 126 minutes = 57,1 colis/h.
    expect(anthony.observedRate).toBeCloseTo(120 / (126 / 60), 3)
    expect(anthony.observedRate).toBeLessThan(60)
    expect(anthony.samples).toBe(2)
  })

  it('écarte les commandes sans nombre de lignes', () => {
    const days = [
      makeDay(
        '2026-08-03',
        [
          { colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 },
          // Densité inconnue : la comparer reviendrait à comparer sans étalon.
          { colis: 100, lines: 0, startHour: 15, pickingMinutes: 30 },
        ],
        110,
        'anthony',
      ),
    ]

    const perf = performanceByOwner(days)
    expect(perf[0].samples).toBe(1)
    expect(perf[0].colis).toBe(100)
  })

  it('ne produit ni NaN ni infini sur des données vides ou dégénérées', () => {
    expect(performanceByOwner([])).toEqual([])

    const noLines = [
      makeDay(
        '2026-08-03',
        [{ colis: 50, lines: 0, startHour: 13, pickingMinutes: 30 }],
        110,
        'anthony',
      ),
    ]
    // Aucune commande exploitable : personne ne doit apparaître avec un écart
    // inventé à partir de rien.
    expect(performanceByOwner(noLines)).toEqual([])

    const zeroColis = [
      makeDay(
        '2026-08-03',
        [{ colis: 0, lines: 10, startHour: 13, pickingMinutes: 30 }],
        110,
        'anthony',
      ),
    ]
    for (const p of performanceByOwner(zeroColis)) {
      expect(Number.isFinite(p.observedRate)).toBe(true)
      expect(Number.isFinite(p.expectedRate)).toBe(true)
      expect(Number.isFinite(p.delta)).toBe(true)
    }
  })

  it('signale un préparateur qui n’a personne à qui se comparer', () => {
    // Chacun sur son propre type de commande : chacun devient la référence de
    // sa tranche, et son écart vaut zéro par construction — pas par performance.
    const days = [
      makeDay(
        '2026-08-03',
        [{ colis: 95, lines: 95, startHour: 13, pickingMinutes: 60 }],
        110,
        'anthony',
      ),
      makeDay(
        '2026-08-03',
        [{ colis: 150, lines: 15, startHour: 13, pickingMinutes: 60 }],
        110,
        'bruno',
      ),
    ]

    const perf = performanceByOwner(days)
    expect(perf).toHaveLength(2)
    for (const p of perf) {
      expect(Math.round(p.delta)).toBe(0)
      // Aucun terrain commun : l'écart ne doit pas être présenté comme un résultat.
      expect(p.comparableShare).toBe(0)
    }
  })

  it('reconnaît un terrain commun quand les densités se recoupent', () => {
    const days = [
      makeDay(
        '2026-08-03',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 50 }],
        110,
        'anthony',
      ),
      makeDay(
        '2026-08-03',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 70 }],
        110,
        'bruno',
      ),
    ]

    const perf = performanceByOwner(days)
    for (const p of perf) expect(p.comparableShare).toBe(1)

    // Sur un terrain commun, le plus rapide ressort devant.
    expect(perf[0].ownerId).toBe('anthony')
    expect(perf[0].delta).toBeGreaterThan(0)
    expect(perf[1].delta).toBeLessThan(0)
  })

  it('mesure la part comparable quand une seule partie du travail se recoupe', () => {
    const days = [
      // Anthony : moitié sur du terrain commun, moitié sur un type qu'il est
      // seul à traiter.
      makeDay(
        '2026-08-03',
        [
          { colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 },
          { colis: 100, lines: 100, startHour: 16, pickingMinutes: 60 },
        ],
        110,
        'anthony',
      ),
      makeDay(
        '2026-08-03',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 }],
        110,
        'bruno',
      ),
    ]

    const anthony = performanceByOwner(days).find((p) => p.ownerId === 'anthony')!
    expect(anthony.comparableShare).toBeCloseTo(0.5, 6)
  })

  it('compte les vacations distinctes de chacun', () => {
    const days = [
      makeDay(
        '2026-08-03',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 }],
        110,
        'anthony',
      ),
      makeDay(
        '2026-08-04',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 }],
        110,
        'anthony',
      ),
      makeDay(
        '2026-08-04',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 }],
        110,
        'bruno',
      ),
    ]

    const perf = performanceByOwner(days)
    expect(perf.find((p) => p.ownerId === 'anthony')?.days).toBe(2)
    expect(perf.find((p) => p.ownerId === 'bruno')?.days).toBe(1)
  })
})
