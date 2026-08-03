import { describe, expect, it } from 'vitest'
import { deriveSyncStatus, type SyncStatusInput } from './status'

const BASE: SyncStatusInput = {
  configured: true, connected: true, online: true, busy: false, pending: 0, lastSuccessAt: 100,
}

describe('état de synchronisation affiché', () => {
  it('couvre les six états compréhensibles', () => {
    expect(deriveSyncStatus({ ...BASE, configured: false }).state).toBe('local')
    expect(deriveSyncStatus({ ...BASE, online: false }).state).toBe('offline')
    expect(deriveSyncStatus({ ...BASE, pending: 2 }).state).toBe('pending')
    expect(deriveSyncStatus({ ...BASE, busy: true }).state).toBe('running')
    expect(deriveSyncStatus(BASE).state).toBe('up-to-date')
    expect(deriveSyncStatus({
      ...BASE,
      outcome: { state: 'error', pulled: 0, pushed: 0, at: 200, error: 'Échec sûr' },
    }).state).toBe('error')
  })

  it('ne déclare jamais à jour avant une première réussite', () => {
    const status = deriveSyncStatus({ ...BASE, lastSuccessAt: undefined })
    expect(status.state).toBe('pending')
    expect(status.label).toContain('Première')
  })

  it('priorise le hors-ligne et conserve le nombre exact en attente', () => {
    const status = deriveSyncStatus({ ...BASE, online: false, pending: 7 })
    expect(status.state).toBe('offline')
    expect(status.detail).toContain('7 modifications')
  })

  it('ne masque pas une erreur par un état en attente', () => {
    const status = deriveSyncStatus({
      ...BASE,
      pending: 4,
      outcome: { state: 'error', pulled: 1, pushed: 0, at: 200, error: 'Message sûr' },
    })
    expect(status).toMatchObject({ state: 'error', detail: 'Message sûr' })
  })
})
