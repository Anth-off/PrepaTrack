import { describe, expect, it } from 'vitest'
import {
  ESTIMATED_MISSING_HELP,
  ESTIMATED_MISSING_LABEL,
  STOCK_SHORTAGE_LABEL,
} from './metricLabels'

describe('libellés des colis manquants', () => {
  it('distingue la perte théorique de la rupture physique', () => {
    expect(ESTIMATED_MISSING_LABEL).toBe('Colis manquants estimés')
    expect(STOCK_SHORTAGE_LABEL).toBe('Colis manquants pour rupture')
    expect(ESTIMATED_MISSING_LABEL).not.toBe(STOCK_SHORTAGE_LABEL)
    expect(ESTIMATED_MISSING_HELP).toContain('temps perdu')
    expect(ESTIMATED_MISSING_HELP).toContain('cadence cible')
    expect(ESTIMATED_MISSING_HELP).toContain('ne représente pas des colis physiques')
  })
})
