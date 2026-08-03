import { describe, expect, it } from 'vitest'
import { makeDay } from './fixtures'
import { recommend } from './recommendations'

/**
 * Ces règles finissent en conseils lus par quelqu'un qui organise sa journée
 * dessus. Deux choses comptent donc autant l'une que l'autre : qu'elles
 * repèrent ce qu'elles annoncent, et qu'elles se taisent quand elles n'ont pas
 * de quoi l'affirmer.
 */

const find = (days: Parameters<typeof recommend>[0]['days'], id: string) =>
  recommend({ days, targetRate: 110 }).find((r) => r.id === id)

describe('temps perdu', () => {
  it('désigne le poste le plus coûteux en colis manquants estimés', () => {
    const day = makeDay('2026-07-27', [
      {
        colis: 200,
        lines: 50,
        startHour: 13,
        pickingMinutes: 120,
        waste: [
          { type: 'travel', minutes: 45 },
          { type: 'incident_wait', minutes: 10 },
        ],
      },
    ])

    const reco = find([day], 'top-loss')
    expect(reco).toBeDefined()
    expect(reco!.title).toContain('Trajet')
    // 45 min à 110 colis/h = 82,5 colis, arrondis à 83.
    expect(reco!.detail).toContain('83 colis manquants estimés')
  })

  it('ne dit rien pour quelques minutes perdues', () => {
    const day = makeDay('2026-07-27', [
      {
        colis: 200,
        lines: 50,
        startHour: 13,
        pickingMinutes: 120,
        waste: [{ type: 'travel', minutes: 2 }],
      },
    ])
    expect(find([day], 'top-loss')).toBeUndefined()
  })
})

describe('décrochage horaire', () => {
  it('repère une seconde partie de vacation plus lente', () => {
    const day = makeDay('2026-07-27', [
      { colis: 130, lines: 30, startHour: 13, pickingMinutes: 60 },
      { colis: 125, lines: 30, startHour: 14, pickingMinutes: 60 },
      { colis: 80, lines: 30, startHour: 15, pickingMinutes: 60 },
      { colis: 70, lines: 30, startHour: 16, pickingMinutes: 60 },
    ])

    const reco = find([day], 'fatigue')
    expect(reco).toBeDefined()
    expect(reco!.title).toMatch(/baisse de \d+ %/)
  })

  it('reste silencieux quand la cadence tient', () => {
    const day = makeDay('2026-07-27', [
      { colis: 110, lines: 30, startHour: 13, pickingMinutes: 60 },
      { colis: 112, lines: 30, startHour: 14, pickingMinutes: 60 },
      { colis: 108, lines: 30, startHour: 15, pickingMinutes: 60 },
      { colis: 111, lines: 30, startHour: 16, pickingMinutes: 60 },
    ])
    expect(find([day], 'fatigue')).toBeUndefined()
  })
})

describe('recherche de palette', () => {
  it('signale une part excessive du temps de commande', () => {
    const day = makeDay('2026-07-27', [
      { colis: 60, lines: 20, startHour: 13, pickingMinutes: 30, setupMinutes: 12 },
      { colis: 60, lines: 20, startHour: 15, pickingMinutes: 30, setupMinutes: 12 },
      { colis: 60, lines: 20, startHour: 17, pickingMinutes: 30, setupMinutes: 12 },
    ])

    const reco = find([day], 'setup')
    expect(reco).toBeDefined()
    expect(reco!.title).toContain('%')
    expect(reco!.detail).toContain('colis manquants estimés')
  })

  it('ne se déclenche pas sur une seule commande', () => {
    const day = makeDay('2026-07-27', [
      { colis: 60, lines: 20, startHour: 13, pickingMinutes: 30, setupMinutes: 20 },
    ])
    expect(find([day], 'setup')).toBeUndefined()
  })
})

describe('densité des commandes', () => {
  it("attribue l'écart à la densité plutôt qu'au rythme", () => {
    const day = makeDay('2026-07-27', [
      { colis: 150, lines: 15, startHour: 13, pickingMinutes: 60 },
      { colis: 140, lines: 14, startHour: 14, pickingMinutes: 60 },
      { colis: 60, lines: 60, startHour: 15, pickingMinutes: 60 },
      { colis: 55, lines: 55, startHour: 16, pickingMinutes: 60 },
    ])

    const reco = find([day], 'density')
    expect(reco).toBeDefined()
    expect(reco!.action).toContain('structurel')
  })
})

describe('position par rapport à l’objectif', () => {
  it('confirme quand la cadence est tenue', () => {
    const day = makeDay('2026-07-27', [
      { colis: 240, lines: 60, startHour: 13, pickingMinutes: 120 },
    ])
    const reco = find([day], 'target')
    expect(reco?.title).toContain('Objectif tenu')
  })

  it('chiffre le retard sans commenter', () => {
    const day = makeDay('2026-07-27', [
      { colis: 120, lines: 60, startHour: 13, pickingMinutes: 120 },
    ])
    const reco = find([day], 'target')
    expect(reco?.title).toContain("sous l'objectif")
    expect(reco?.detail).toContain('120 colis')
  })
})

describe('fiabilité annoncée', () => {
  it('marque « indicatif » sur un échantillon réduit', () => {
    const day = makeDay('2026-07-27', [
      { colis: 240, lines: 60, startHour: 13, pickingMinutes: 120 },
    ])
    expect(find([day], 'target')!.confidence).toBe('indicatif')
  })

  it('passe à « solide » avec assez de vacations', () => {
    const days = Array.from({ length: 8 }, (_, i) =>
      makeDay(`2026-07-${String(i + 10).padStart(2, '0')}`, [
        { colis: 240, lines: 60, startHour: 13, pickingMinutes: 120 },
      ]),
    )
    expect(find(days, 'target')!.confidence).toBe('solide')
  })

  it('ne renvoie rien sans aucune donnée', () => {
    expect(recommend({ days: [], targetRate: 110 })).toEqual([])
  })
})

describe('classement', () => {
  it('remonte les constats les plus coûteux en premier', () => {
    const day = makeDay('2026-07-27', [
      {
        colis: 200,
        lines: 50,
        startHour: 13,
        pickingMinutes: 120,
        waste: [{ type: 'travel', minutes: 60 }],
      },
    ])
    const all = recommend({ days: [day], targetRate: 110 })
    const severities = all.map((r) => r.severity)
    // Aucun « info » ne doit passer devant un « high ».
    expect(severities.indexOf('high')).toBeLessThan(
      severities.includes('info') ? severities.indexOf('info') : Infinity,
    )
  })
})
