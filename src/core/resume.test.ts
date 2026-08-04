import { describe, expect, it } from 'vitest'
import { deriveView, type Snapshot } from './machine'
import { buildResumeSummary, RESUME_PROMPT_AFTER } from './resume'
import { dayKey, MINUTE } from './time'
import type { Order, Segment, SegmentType, Workday } from './types'
import { DEFAULT_SETTINGS, EMPTY_SUPPORTS } from './types'

const T = new Date(2026, 7, 4, 8, 0, 0).getTime()
const workday: Workday = {
  id: 'w1', date: dayKey(T), status: 'open', startedAt: T,
  updatedAt: T, syncState: 'pending',
}
const order: Order = {
  id: 'o1', workdayId: 'w1', status: 'open', orderType: 'normale',
  colisPlanned: 80, linesCount: 20, supports: { ...EMPTY_SUPPORTS },
  startedAt: T, updatedAt: T, syncState: 'pending',
}

function segment(type: SegmentType, over: Partial<Segment> = {}): Segment {
  return {
    id: 's1', workdayId: 'w1', orderId: 'o1', type, startedAt: T,
    updatedAt: T, syncState: 'pending', ...over,
  }
}

function summary(active: Segment, away = RESUME_PROMPT_AFTER) {
  const snap: Snapshot = { workday, orders: [order], segments: [active] }
  return buildResumeSummary({
    snap, view: deriveView(snap), settings: DEFAULT_SETTINGS,
    lastSeenAt: T + 10 * MINUTE - away, now: T + 10 * MINUTE,
  })
}

describe('résumé après veille ou fermeture', () => {
  it('ne bloque pas après une interruption très courte', () => {
    expect(summary(segment('picking'), RESUME_PROMPT_AFTER - 1)).toBeUndefined()
  })

  it('retrouve une préparation et sa commande sans modifier le snapshot', () => {
    const active = segment('picking')
    const snap: Snapshot = { workday, orders: [order], segments: [active] }
    const before = structuredClone(snap)
    const result = buildResumeSummary({
      snap, view: deriveView(snap), settings: DEFAULT_SETTINGS,
      lastSeenAt: T + 8 * MINUTE, now: T + 10 * MINUTE,
    })
    expect(result).toMatchObject({ actionLabel: 'Préparation', orderLabel: '80 colis · 20 lignes · normale' })
    expect(snap).toEqual(before)
  })

  it.each([
    ['wrapping', 'Filmage'],
    ['travel', 'Trajet'],
    ['break_10', 'Pause 10 min'],
  ] as const)('résume correctement %s', (type, label) => {
    expect(summary(segment(type))?.actionLabel).toBe(label)
  })

  it('préserve la phase à reprendre dans une interruption imbriquée', () => {
    const active = segment('break_10', {
      stack: [
        { type: 'picking', orderId: 'o1' },
        { type: 'travel', orderId: 'o1' },
      ],
    })
    expect(summary(active)).toMatchObject({ resumeLabel: 'Trajet', orderLabel: expect.stringContaining('80 colis') })
    expect(active.stack).toHaveLength(2)
  })

  it('utilise le seuil configuré pour avertir immédiatement', () => {
    const active = segment('travel', { startedAt: T })
    const result = buildResumeSummary({
      snap: { workday, orders: [order], segments: [active] },
      view: deriveView({ workday, orders: [order], segments: [active] }),
      settings: { ...DEFAULT_SETTINGS, stuckThresholds: { ...DEFAULT_SETTINGS.stuckThresholds, interruption: 5 } },
      lastSeenAt: T + MINUTE, now: T + 6 * MINUTE,
    })
    expect(result?.warning).toBe(true)
  })

  it('fonctionne au premier redémarrage même sans heartbeat historique', () => {
    const active = segment('picking', { startedAt: T })
    const snap = { workday, orders: [order], segments: [active] }
    expect(buildResumeSummary({
      snap, view: deriveView(snap), settings: DEFAULT_SETTINGS,
      now: T + 2 * MINUTE,
    })).toBeDefined()
  })
})
