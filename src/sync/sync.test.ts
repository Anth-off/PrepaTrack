import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getMeta, setMeta, wipeAll } from '../db/db'
import { countPending } from './sync'
import { SYNC_TABLES } from './tables'
import type { Segment, Workday } from '../core/types'

/**
 * Tests de la mécanique de fusion sans réseau : les mappers et les règles de
 * priorité. Ce sont eux qui peuvent corrompre des données réelles, alors que le
 * transport HTTP, lui, échoue bruyamment.
 */

const T = new Date(2026, 6, 30, 13, 0, 0).getTime()

beforeEach(async () => {
  await db.delete()
  await db.open()
})

function segment(over: Partial<Segment> = {}): Segment {
  return {
    id: 's1',
    workdayId: 'w1',
    type: 'picking',
    startedAt: T,
    updatedAt: T,
    syncState: 'pending',
    ...over,
  }
}

const segmentTable = SYNC_TABLES.find((t) => t.remote === 'segments')!
const workdayTable = SYNC_TABLES.find((t) => t.remote === 'workdays')!

describe('conversion locale ↔ distante', () => {
  it('préserve un segment en cours à travers un aller-retour', () => {
    const open = segment({ endedAt: undefined })
    const row = segmentTable.toRow(open)
    expect(row.ended_at).toBeNull()

    const back = segmentTable.fromRow(row) as Segment
    // Le point critique : `null` doit redevenir `undefined`, sinon le segment
    // en cours ne serait plus reconnu comme tel au retour du serveur.
    expect(back.endedAt).toBeUndefined()
    expect(back.startedAt).toBe(T)
    expect(back.syncState).toBe('synced')
  })

  it('préserve la pile de suspension', () => {
    const withStack = segment({
      type: 'break_10',
      stack: [
        { type: 'picking', orderId: 'o1' },
        { type: 'travel' },
      ],
    })
    const back = segmentTable.fromRow(segmentTable.toRow(withStack)) as Segment
    expect(back.stack).toEqual([
      { type: 'picking', orderId: 'o1' },
      { type: 'travel' },
    ])
  })

  it('préserve une journée close et ses heures supplémentaires', () => {
    const workday: Workday = {
      id: 'w1',
      date: '2026-07-30',
      status: 'closed',
      startedAt: T,
      endedAt: T + 1000,
      overtimeStartedAt: T + 500,
      updatedAt: T,
      syncState: 'pending',
    }
    const back = workdayTable.fromRow(workdayTable.toRow(workday)) as Workday
    expect(back).toMatchObject({
      status: 'closed',
      endedAt: T + 1000,
      overtimeStartedAt: T + 500,
    })
  })

  it('convertit une suppression logique dans les deux sens', () => {
    const deleted = segment({ deletedAt: T + 10, endedAt: T + 5 })
    const row = segmentTable.toRow(deleted)
    expect(row.deleted_at).toBe(T + 10)
    expect((segmentTable.fromRow(row) as Segment).deletedAt).toBe(T + 10)
  })
})

describe('comptage des éléments en attente', () => {
  it('additionne les lignes non synchronisées de toutes les tables', async () => {
    await db.segments.bulkPut([
      segment({ id: 'a', syncState: 'pending' }),
      segment({ id: 'b', syncState: 'synced' }),
    ])
    await db.workdays.put({
      id: 'w1',
      date: '2026-07-30',
      status: 'open',
      startedAt: T,
      updatedAt: T,
      syncState: 'pending',
    })
    expect(await countPending()).toBe(2)
  })
})

describe('effacement complet', () => {
  it('marque tout supprimé et à renvoyer, sans effacer physiquement', async () => {
    await db.workdays.put({
      id: 'w1',
      date: '2026-07-30',
      status: 'open',
      startedAt: T,
      updatedAt: T,
      syncState: 'synced',
    })
    await db.segments.put(segment({ syncState: 'synced' }))

    await wipeAll()

    const workday = await db.workdays.get('w1')
    const seg = await db.segments.get('s1')
    // Les lignes doivent survivre localement pour que la suppression puisse
    // remonter au serveur, et de là redescendre sur l'autre appareil.
    expect(workday?.deletedAt).toBeDefined()
    expect(workday?.syncState).toBe('pending')
    // `updatedAt` doit avancer, sinon le curseur de l'autre appareil ignorerait
    // la suppression.
    expect(workday!.updatedAt).toBeGreaterThan(T)
    expect(seg?.deletedAt).toBeDefined()
    expect(await countPending()).toBe(2)
  })
})

describe('stockage des valeurs de service', () => {
  it('relit ce qui a été écrit et retombe sur la valeur par défaut sinon', async () => {
    expect(await getMeta('sync:cursor:segments', 0)).toBe(0)
    await setMeta('sync:cursor:segments', T)
    expect(await getMeta('sync:cursor:segments', 0)).toBe(T)
  })
})
