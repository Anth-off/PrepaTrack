import { describe, expect, it } from 'vitest'
import {
  availableDates,
  byOwnerForDate,
  incidentsByOwner,
  teamDayTotals,
  STALE_AFTER,
} from './analysis'
import type { DayData } from './analysis'
import { makeDay } from './fixtures'
import { HOUR } from './time'

/**
 * Ces agrégats sont ce qu'un gestionnaire lira avant de se faire une opinion sur
 * une journée. Une vacation mal comptée ne produit pas un affichage bancal :
 * elle fait passer une équipe pour moins performante qu'elle ne l'a été.
 */

/** Ouvre une vacation en retirant sa fin, comme un chrono resté en marche. */
function leaveOpen(day: DayData, presence: number): DayData {
  const segments = day.segments.map((s, i) =>
    i === day.segments.length - 1 ? { ...s, endedAt: undefined } : s,
  )
  return {
    ...day,
    segments,
    metrics: { ...day.metrics, endedAt: undefined, presence },
  }
}

describe('bilan d’une journée d’équipe', () => {
  it('sépare journée close, vacation ouverte et absence de données', () => {
    const closed = makeDay(
      '2026-08-05',
      [{ colis: 300, lines: 60, startHour: 13, pickingMinutes: 180 }],
      110,
      'anthony',
    )
    const stale = leaveOpen(
      makeDay(
        '2026-08-05',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 }],
        110,
        'bruno',
      ),
      STALE_AFTER + HOUR,
    )

    // Chloé est en poste mais n'a rien synchronisé.
    const rows = byOwnerForDate([closed, stale], '2026-08-05', ['anthony', 'bruno', 'chloe'])

    expect(rows.find((r) => r.ownerId === 'anthony')?.state).toBe('closed')
    expect(rows.find((r) => r.ownerId === 'bruno')?.state).toBe('stale')
    expect(rows.find((r) => r.ownerId === 'chloe')?.state).toBe('missing')
    expect(rows).toHaveLength(3)
  })

  it('écarte des totaux la vacation dont le chrono a tourné toute la nuit', () => {
    const closed = makeDay(
      '2026-08-05',
      [{ colis: 300, lines: 60, startHour: 13, pickingMinutes: 180 }],
      110,
      'anthony',
    )
    const stale = leaveOpen(
      makeDay(
        '2026-08-05',
        [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 }],
        110,
        'bruno',
      ),
      STALE_AFTER + HOUR,
    )

    const rows = byOwnerForDate([closed, stale], '2026-08-05')
    const totals = teamDayTotals(rows)

    // Les 100 colis de Bruno sont montrés sur sa ligne, mais ses 20 heures de
    // chrono ruineraient la cadence de toute l'équipe.
    expect(totals.colis).toBe(300)
    expect(totals.counted).toBe(1)
    expect(totals.excluded).toBe(1)
    expect(totals.rate).toBeCloseTo(300 / (closed.metrics.worked / HOUR), 4)
  })

  it('calcule la cadence par somme et non par moyenne des cadences', () => {
    // Un poste complet à 100/h et une demi-journée à 200/h.
    const full = makeDay(
      '2026-08-05',
      [{ colis: 400, lines: 100, startHour: 13, pickingMinutes: 240 }],
      110,
      'anthony',
    )
    const half = makeDay(
      '2026-08-05',
      [{ colis: 200, lines: 50, startHour: 13, pickingMinutes: 60 }],
      110,
      'bruno',
    )

    const totals = teamDayTotals(byOwnerForDate([full, half], '2026-08-05'))
    const expected = 600 / ((full.metrics.worked + half.metrics.worked) / HOUR)

    expect(totals.rate).toBeCloseTo(expected, 4)
    // La moyenne des deux cadences donnerait un chiffre nettement plus flatteur.
    const naive = (full.metrics.rates.day + half.metrics.rates.day) / 2
    expect(totals.rate).toBeLessThan(naive)
  })

  it('ne compte pas un préparateur sans donnée comme une journée à zéro', () => {
    const closed = makeDay(
      '2026-08-05',
      [{ colis: 300, lines: 60, startHour: 13, pickingMinutes: 180 }],
      110,
      'anthony',
    )

    const rows = byOwnerForDate([closed], '2026-08-05', ['anthony', 'bruno'])
    const totals = teamDayTotals(rows)

    // Sans cette règle, la cadence d'équipe serait divisée par deux à cause de
    // quelqu'un qui n'a simplement pas encore retrouvé du réseau.
    expect(totals.counted).toBe(1)
    expect(totals.rate).toBeCloseTo(closed.metrics.rates.day, 4)
  })

  it('ne retient que les vacations de la date demandée', () => {
    const days = [
      makeDay('2026-08-05', [{ colis: 100, lines: 25, startHour: 13, pickingMinutes: 60 }], 110, 'anthony'),
      makeDay('2026-08-06', [{ colis: 200, lines: 50, startHour: 13, pickingMinutes: 60 }], 110, 'anthony'),
    ]
    expect(teamDayTotals(byOwnerForDate(days, '2026-08-05')).colis).toBe(100)
    expect(teamDayTotals(byOwnerForDate(days, '2026-08-06')).colis).toBe(200)
  })

  it('liste les dates disponibles, la plus récente en tête', () => {
    const days = [
      makeDay('2026-08-05', [{ colis: 10, lines: 5, startHour: 13, pickingMinutes: 10 }], 110, 'a'),
      makeDay('2026-08-07', [{ colis: 10, lines: 5, startHour: 13, pickingMinutes: 10 }], 110, 'a'),
      makeDay('2026-08-07', [{ colis: 10, lines: 5, startHour: 13, pickingMinutes: 10 }], 110, 'b'),
    ]
    expect(availableDates(days)).toEqual(['2026-08-07', '2026-08-05'])
  })

  it('regroupe les ruptures par journée et par préparateur', () => {
    const anthony = makeDay(
      '2026-08-05',
      [{ colis: 96, lines: 25, startHour: 13, pickingMinutes: 60 }],
      110,
      'anthony',
    )
    anthony.shortages = [
      {
        id: 'r1',
        workdayId: anthony.id,
        orderId: anthony.metrics.orders[0].order.id,
        at: Date.now(),
        quantity: 4,
        resolved: false,
        ownerId: 'anthony',
        updatedAt: Date.now(),
        syncState: 'synced',
      },
    ]

    const row = byOwnerForDate([anthony], '2026-08-05')[0]
    expect(row.shortageQuantity).toBe(4)
    expect(row.unresolvedShortages).toBe(1)
  })
})

describe('aléas par préparateur', () => {
  it('n’attribue à chacun que ce qu’il a subi', () => {
    const days = [
      makeDay(
        '2026-08-05',
        [
          {
            colis: 100,
            lines: 25,
            startHour: 13,
            pickingMinutes: 60,
            waste: [{ type: 'incident_material', minutes: 30 }],
          },
        ],
        110,
        'anthony',
      ),
      makeDay(
        '2026-08-05',
        [
          {
            colis: 100,
            lines: 25,
            startHour: 13,
            pickingMinutes: 60,
            waste: [{ type: 'incident_wait', minutes: 15 }],
          },
        ],
        110,
        'bruno',
      ),
    ]

    const byOwner = incidentsByOwner(days, 110)
    const anthony = byOwner.get('anthony')!
    const bruno = byOwner.get('bruno')!

    expect(anthony).toHaveLength(1)
    expect(anthony[0].type).toBe('incident_material')
    expect(anthony[0].time).toBe(30 * 60_000)
    expect(bruno[0].type).toBe('incident_wait')
    // La panne d'Anthony ne doit pas apparaître dans le relevé de Bruno.
    expect(bruno.some((l) => l.type === 'incident_material')).toBe(false)
  })

  it('ignore les trajets, qui relèvent de l’organisation', () => {
    const days = [
      makeDay(
        '2026-08-05',
        [
          {
            colis: 100,
            lines: 25,
            startHour: 13,
            pickingMinutes: 60,
            waste: [{ type: 'travel', minutes: 20 }],
          },
        ],
        110,
        'anthony',
      ),
    ]
    expect(incidentsByOwner(days, 110).has('anthony')).toBe(false)
  })
})
