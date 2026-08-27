import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoachingAlert } from '../core/types'
import { canRepeatCoachingAlert, coachingAlertsFor, markCoachingAlertRead, saveCoachingAlert, supersedeCoachingAlerts } from './coaching'
import { db } from './db'

const T = new Date(2026, 7, 27, 15).getTime()

describe('persistance du coach hors ligne', () => {
  beforeEach(async () => { await db.delete(); await db.open() })

  async function add(overrides: Partial<CoachingAlert> = {}) {
    return saveCoachingAlert({
      workdayId: 'w1', at: T, cause: 'travel', severity: 'medium',
      title: 'Trajets', explanation: 'Facteur améliorable.', action: 'Regrouper les déplacements.',
      evidence: [{ code: 'travel', label: 'Trajet', value: 8, unit: 'minutes', confidence: 1 }],
      confidence: 0.9, delayPackages: 18, modelVersion: 'test', ...overrides,
    })
  }

  it('enregistre, marque comme lue et conserve la ligne synchronisable', async () => {
    const row = await add()
    await markCoachingAlertRead(row.id, T + 1_000)
    expect(await coachingAlertsFor('w1')).toEqual([
      expect.objectContaining({ id: row.id, readAt: T + 1_000, syncState: 'pending' }),
    ])
  })

  it('remplace un diagnostic invalidé par une correction de timeline', async () => {
    await add()
    expect(await supersedeCoachingAlerts('w1', T - 1)).toBe(1)
    expect(await coachingAlertsFor('w1')).toEqual([
      expect.objectContaining({ supersededAt: expect.any(Number) }),
    ])
  })

  it('respecte 15 minutes de refroidissement sauf aggravation de 15 colis', async () => {
    const previous = await add()
    expect(canRepeatCoachingAlert(previous, 'travel', 30, T + 5 * 60_000)).toBe(false)
    expect(canRepeatCoachingAlert(previous, 'travel', 33, T + 5 * 60_000)).toBe(true)
    expect(canRepeatCoachingAlert(previous, 'travel', 18, T + 15 * 60_000)).toBe(true)
    expect(canRepeatCoachingAlert(previous, 'idle', 18, T + 1_000)).toBe(true)
  })
})
