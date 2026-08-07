import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { recoverOrphanedWorkdays } from './recovery'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('récupération locale', () => {
  it('reconstruit une vacation ouverte à partir de sa timeline', async () => {
    await db.segments.put({
      id: 'segment-1', workdayId: 'day-1', type: 'picking', startedAt: 1_000,
      updatedAt: 1_000, syncState: 'pending',
    })
    expect(await recoverOrphanedWorkdays()).toBe(1)
    expect(await db.workdays.get('day-1')).toMatchObject({
      id: 'day-1', status: 'open', startedAt: 1_000,
    })
  })

  it('ne ressuscite pas une timeline supprimée volontairement', async () => {
    await db.segments.put({
      id: 'segment-1', workdayId: 'day-1', type: 'picking', startedAt: 1_000,
      updatedAt: 2_000, syncState: 'pending', deletedAt: 2_000,
    })
    expect(await recoverOrphanedWorkdays()).toBe(0)
    expect(await db.workdays.get('day-1')).toBeUndefined()
  })

  it('répare une vacation marquée supprimée dont la timeline est encore active', async () => {
    await db.workdays.put({
      id: 'day-1', date: '1970-01-01', status: 'closed', startedAt: 1_000,
      updatedAt: 2_000, syncState: 'pending', deletedAt: 2_000,
    })
    await db.segments.put({
      id: 'segment-1', workdayId: 'day-1', type: 'picking', startedAt: 1_000,
      updatedAt: 1_000, syncState: 'pending',
    })

    expect(await recoverOrphanedWorkdays()).toBe(1)
    expect(await db.workdays.get('day-1')).toMatchObject({
      id: 'day-1', status: 'open', startedAt: 1_000, deletedAt: undefined,
    })
  })
})
