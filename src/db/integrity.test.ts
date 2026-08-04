import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { IntegrityIssue } from '../core/integrity'
import { db } from './db'
import { dismissIntegrityIssue, getIntegrityDismissals, visibleIntegrityIssues } from './integrity'

const anomaly: IntegrityIssue = {
  id: 'unexplained_count:o1', fingerprint: 'o1@1', rule: 'unexplained_count',
  severity: 'check', entity: 'order', entityId: 'o1', title: 'Écart',
  detail: 'Détail', correction: 'Correction',
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('confirmation des faux positifs', () => {
  it('masque une anomalie confirmée hors ligne', async () => {
    await dismissIntegrityIssue(anomaly)
    expect(visibleIntegrityIssues([anomaly], await getIntegrityDismissals())).toEqual([])
  })

  it('réaffiche la règle quand la donnée a été modifiée', async () => {
    await dismissIntegrityIssue(anomaly)
    const changed = { ...anomaly, fingerprint: 'o1@2' }
    expect(visibleIntegrityIssues([changed], await getIntegrityDismissals())).toEqual([changed])
  })
})
