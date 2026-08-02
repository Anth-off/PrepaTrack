import { describe, expect, it } from 'vitest'
import { computeAlerts } from './alerts'
import { MINUTE } from './time'
import type { Segment, SegmentType } from './types'
import { DEFAULT_SETTINGS } from './types'

const T = new Date(2026, 6, 30, 13, 0, 0).getTime()

function seg(type: SegmentType): Segment {
  return { id: 's1', workdayId: 'w1', type, startedAt: T, updatedAt: T, syncState: 'pending' }
}

describe('alertes de fin de pause', () => {
  it('ne dit rien tant que la pause est dans les clous', () => {
    expect(computeAlerts(seg('break_10'), DEFAULT_SETTINGS, T + 9 * MINUTE)).toHaveLength(0)
  })

  it('signale le dépassement et le chiffre', () => {
    const alerts = computeAlerts(seg('break_10'), DEFAULT_SETTINGS, T + 14 * MINUTE)
    expect(alerts[0].kind).toBe('break_end')
    expect(alerts[0].detail).toContain('4 min')
  })

  it('utilise le quota long pour la grande pause', () => {
    expect(computeAlerts(seg('break_30'), DEFAULT_SETTINGS, T + 25 * MINUTE)).toHaveLength(0)
    expect(computeAlerts(seg('break_30'), DEFAULT_SETTINGS, T + 35 * MINUTE)[0].kind).toBe(
      'break_end',
    )
  })
})

describe('alerte de chrono oublié', () => {
  it('signale une interruption anormalement longue', () => {
    const alerts = computeAlerts(seg('travel'), DEFAULT_SETTINGS, T + 25 * MINUTE)
    expect(alerts[0].kind).toBe('stuck')
  })

  it('signale un briefing resté ouvert', () => {
    // Le cas réellement rencontré : journée lancée le soir, briefing jamais
    // fermé, quatre heures au compteur le lendemain.
    expect(computeAlerts(seg('briefing'), DEFAULT_SETTINGS, T + 4 * 60 * MINUTE)).toHaveLength(1)
    expect(computeAlerts(seg('briefing'), DEFAULT_SETTINGS, T + 20 * MINUTE)).toHaveLength(0)
  })

  it('laisse une prépa normale tranquille', () => {
    expect(computeAlerts(seg('picking'), DEFAULT_SETTINGS, T + 60 * MINUTE)).toHaveLength(0)
  })

  it('ne dit rien sans segment actif', () => {
    expect(computeAlerts(undefined, DEFAULT_SETTINGS, T)).toHaveLength(0)
  })
})
