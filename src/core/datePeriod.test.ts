import { describe, expect, it } from 'vitest'
import { filterByDatePeriod } from './datePeriod'

const days = [
  { date: '2026-08-21', id: 'friday' },
  { date: '2026-08-18', id: 'tuesday' },
  { date: '2026-08-17', id: 'monday' },
  { date: '2026-07-01', id: 'old' },
]

describe('filtre de dates des statistiques', () => {
  it('inclut les deux bornes choisies', () => {
    const filtered = filterByDatePeriod(days, 'custom', Date.now(), '2026-08-17', '2026-08-18')
    expect(filtered.map((day) => day.id)).toEqual(['tuesday', 'monday'])
  })

  it('permet de choisir une date unique', () => {
    const filtered = filterByDatePeriod(days, 'custom', Date.now(), '2026-08-21', '2026-08-21')
    expect(filtered.map((day) => day.id)).toEqual(['friday'])
  })

  it('normalise des bornes saisies dans l’ordre inverse', () => {
    const filtered = filterByDatePeriod(days, 'custom', Date.now(), '2026-08-21', '2026-08-17')
    expect(filtered.map((day) => day.id)).toEqual(['friday', 'tuesday', 'monday'])
  })

  it('calcule les périodes rapides en jours calendaires locaux', () => {
    const now = new Date(2026, 7, 21, 10, 30).getTime()
    expect(filterByDatePeriod(days, 7, now).map((day) => day.id)).toEqual([
      'friday',
      'tuesday',
      'monday',
    ])
  })
})
