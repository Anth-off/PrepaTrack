import { describe, expect, it } from 'vitest'
import {
  DAILY_PACKAGE_TARGET,
  MANAGER_TARGET_RATE,
  OPERATIONAL_TARGET_RATE,
  dailyProductionStatus,
} from './productionPlan'
import { hhmm } from './time'

function local(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute).getTime()
}

describe('planning de production quotidien', () => {
  it('calcule les jalons du lundi au jeudi sur les 350 minutes productives', () => {
    const date = '2026-08-17' // lundi
    const briefing = dailyProductionStatus(date, 0, local(date, 13, 10))
    expect(briefing.expected).toBe(0)
    expect(hhmm(briefing.startAt)).toBe('13:00')
    expect(hhmm(briefing.ordersDueAt)).toBe('20:00')
    expect(hhmm(briefing.endAt)).toBe('20:30')

    const firstPause = dailyProductionStatus(date, 229, local(date, 15))
    expect(firstPause.expected).toBeCloseTo((100 / 350) * DAILY_PACKAGE_TARGET, 6)
    expect(firstPause.checkpoints.map((item) => item.target)).toEqual([229, 480, 686, 800])

    expect(dailyProductionStatus(date, 229, local(date, 15, 5)).expected).toBeCloseTo(
      firstPause.expected,
      6,
    )
    expect(dailyProductionStatus(date, 480, local(date, 17)).expected).toBe(480)
    expect(dailyProductionStatus(date, 480, local(date, 17, 15)).expected).toBe(480)
    expect(dailyProductionStatus(date, 686, local(date, 19)).expected).toBeCloseTo(
      (300 / 350) * DAILY_PACKAGE_TARGET,
      6,
    )
    expect(dailyProductionStatus(date, 800, local(date, 20)).expected).toBe(800)
  })

  it('avance tout le planning du vendredi de 30 minutes', () => {
    const date = '2026-08-21' // vendredi
    const status = dailyProductionStatus(date, 0, local(date, 12, 30))

    expect(status.friday).toBe(true)
    expect(hhmm(status.startAt)).toBe('12:30')
    expect(status.checkpoints.map((item) => hhmm(item.at))).toEqual([
      '14:30',
      '16:30',
      '18:30',
      '19:30',
    ])
    expect(hhmm(status.ordersDueAt)).toBe('19:30')
    expect(hhmm(status.endAt)).toBe('20:00')
  })

  it('distingue la cadence chef de la cadence active nécessaire', () => {
    expect(MANAGER_TARGET_RATE).toBeCloseTo(800 / 7, 8)
    expect(OPERATIONAL_TARGET_RATE).toBeCloseTo(800 / (350 / 60), 8)

    const date = '2026-08-17'
    const onTrack = dailyProductionStatus(date, 229, local(date, 15))
    expect(onTrack.requiredRate).toBeCloseTo(
      (800 - 229) / ((350 - 100) / 60),
      8,
    )
  })
})
