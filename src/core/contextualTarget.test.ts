import { describe, expect, it } from 'vitest'
import { makeDay } from './fixtures'
import { contextualTarget, median } from './contextualTarget'
import { EMPTY_SUPPORTS } from './types'

function daysFor(rates: number[], lines = 20) {
  return rates.map((rate, index) =>
    makeDay(`2026-07-${String(index + 1).padStart(2, '0')}`, [
      { colis: rate, lines, startHour: 13, pickingMinutes: 60, type: 'normale' },
    ]),
  )
}

describe('objectif contextuel', () => {
  it('donne des références différentes à deux densités', () => {
    const dense = daysFor([118, 120, 122], 10)
    const eclate = daysFor([58, 60, 62], 60)
    const denseTarget = contextualTarget([...dense, ...eclate], {
      orderType: 'normale', colis: 120, linesCount: 10,
    }, 110)
    const eclateTarget = contextualTarget([...dense, ...eclate], {
      orderType: 'normale', colis: 60, linesCount: 60,
    }, 110)
    expect(denseTarget.rate).toBe(120)
    expect(eclateTarget.rate).toBe(60)
    expect(denseTarget.source).toBe('personal-history')
  })

  it('utilise l’objectif manuel sous le minimum et rend l’échantillon visible', () => {
    const result = contextualTarget(daysFor([80, 90]), {
      orderType: 'normale', colis: 100, linesCount: 20,
    }, 110)
    expect(result).toMatchObject({ rate: 110, source: 'manual', samples: 2, minimumSamples: 3 })
    expect(result.explanation).toContain('2/3')
  })

  it('emploie une médiane robuste aux valeurs extrêmes', () => {
    const days = [90, 100, 1000].map((rate, index) =>
      makeDay(`2026-06-${String(index + 1).padStart(2, '0')}`, [{
        colis: 100,
        lines: 20,
        startHour: 13,
        pickingMinutes: (100 / rate) * 60,
        type: 'normale',
      }]),
    )
    const result = contextualTarget(days, {
      orderType: 'normale', colis: 100, linesCount: 20,
    }, 110)
    expect(result.rate).toBe(100)
    expect(result.method).toBe('median')
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('compare le type et le nombre de supports quand ils sont connus', () => {
    const days = daysFor([90, 100, 110])
    for (const day of days) day.metrics.orders[0].order.supports = { ...EMPTY_SUPPORTS, europe: 2 }
    const matching = contextualTarget(days, {
      orderType: 'normale', colis: 100, linesCount: 20,
      supports: { ...EMPTY_SUPPORTS, europe: 2 },
    }, 110)
    const otherSupport = contextualTarget(days, {
      orderType: 'normale', colis: 100, linesCount: 20,
      supports: { ...EMPTY_SUPPORTS, ipp: 2 },
    }, 110)
    expect(matching).toMatchObject({ rate: 100, samples: 3, source: 'personal-history' })
    expect(otherSupport).toMatchObject({ rate: 110, samples: 0, source: 'manual' })
  })

  it('est déterministe quel que soit l’ordre des journées', () => {
    const days = daysFor([95, 105, 100, 90])
    const input = { orderType: 'normale' as const, colis: 100, linesCount: 20 }
    expect(contextualTarget(days, input, 110)).toEqual(
      contextualTarget([...days].reverse(), input, 110),
    )
  })
})
