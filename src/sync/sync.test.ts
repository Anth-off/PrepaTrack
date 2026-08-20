import 'fake-indexeddb/auto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getMeta, setMeta, wipeAll } from '../db/db'
import {
  applyRemoteRows,
  classifySyncError,
  countPending,
  formatSyncDiagnostic,
  getLastSyncAt,
  getLastSyncAttemptAt,
  runSync,
  sanitizeSyncError,
  syncTables,
} from './sync'
import { SYNC_TABLES } from './tables'
import { rememberKnownOwnerIds, saveProfile } from './profile'
import type { OrderPallet, Segment, StockShortage, Workday } from '../core/types'

/**
 * Tests de la mécanique de fusion sans réseau : les mappers et les règles de
 * priorité. Ce sont eux qui peuvent corrompre des données réelles, alors que le
 * transport HTTP, lui, échoue bruyamment.
 */

const T = new Date(2026, 6, 30, 13, 0, 0).getTime()

beforeEach(async () => {
  await db.delete()
  await db.open()
  await saveProfile(undefined)
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

describe('synchronisation des palettes', () => {
  it('préserve le magasin, les bornes et le support', () => {
    const pallet: OrderPallet = {
      id: 'p1', workdayId: 'w1', orderId: 'o1', number: 2, storeNumber: 2,
      support: 'europe', startedAt: T, endedAt: T + 60_000,
      startCount: 0, endCount: 18, updatedAt: T, syncState: 'pending',
    }
    const back = palletTable.fromRow(palletTable.toRow(pallet)) as OrderPallet
    expect(back).toMatchObject({
      id: 'p1', orderId: 'o1', number: 2, storeNumber: 2,
      support: 'europe', startCount: 0, endCount: 18,
    })
  })
})

describe('propriétaire envoyé au serveur', () => {
  const workday: Workday = {
    id: 'w1',
    date: '2026-08-20',
    status: 'open',
    startedAt: T,
    updatedAt: T,
    syncState: 'pending',
  }

  it('remplace un UUID d’ancien projet par le compte courant', async () => {
    await saveProfile({
      userId: 'compte-actuel',
      preparerId: 'p1',
      badge: '6504109',
      name: 'Anthony',
      role: 'manager',
    })
    rememberKnownOwnerIds(['compte-actuel'])
    const stale: Workday = { ...workday, ownerId: 'uuid-ancien-projet' }
    expect(workdayTable.toRow(stale).user_id).toBe('compte-actuel')
  })

  it('conserve le propriétaire d’un collègue du projet actuel', async () => {
    await saveProfile({
      userId: 'compte-actuel',
      preparerId: 'p1',
      badge: '6504109',
      name: 'Anthony',
      role: 'manager',
    })
    rememberKnownOwnerIds(['compte-actuel', 'un-collegue'])
    const colleague: Workday = { ...workday, ownerId: 'un-collegue' }
    expect(workdayTable.toRow(colleague).user_id).toBe('un-collegue')
  })
})

const segmentTable = SYNC_TABLES.find((t) => t.remote === 'segments')!
const workdayTable = SYNC_TABLES.find((t) => t.remote === 'workdays')!
const shortageTable = SYNC_TABLES.find((t) => t.remote === 'stock_shortages')!
const palletTable = SYNC_TABLES.find((t) => t.remote === 'order_pallets')!

function fakeClient(unavailable?: string) {
  const upserts: string[] = []
  const client = {
    from(table: string) {
      const query = {
        select: () => query,
        gt: () => query,
        order: () => query,
        range: async () =>
          unavailable === table
            ? {
                data: null,
                error: {
                  code: 'PGRST205',
                  message: `Could not find the table public.${table} in the schema cache`,
                },
              }
            : { data: [], error: null },
        upsert: async () => {
          upserts.push(table)
          return unavailable === table
            ? { error: { code: 'PGRST205', message: 'Schema cache unavailable' } }
            : { error: null }
        },
      }
      return query
    },
  } as unknown as SupabaseClient

  return { client, upserts }
}

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

  it('conserve dernière tentative et dernière réussite après réouverture', async () => {
    const [first, second] = await Promise.all([runSync(), runSync()])
    expect(first).toEqual(second)
    expect(await getLastSyncAttemptAt()).toBe(first.at)
    await setMeta('sync:lastAt', T)
    await db.close()
    await db.open()
    expect(await getLastSyncAt()).toBe(T)
    expect(await getLastSyncAttemptAt()).toBe(first.at)
  })
})

describe('conflits entre deux appareils', () => {
  it('garde la modification locale la plus récente', async () => {
    await db.segments.put(segment({ note: 'appareil A', updatedAt: T + 20, syncState: 'pending' }))
    const applied = await applyRemoteRows(segmentTable, [
      segment({ note: 'appareil B', updatedAt: T + 10, syncState: 'synced' }),
    ])
    expect(applied).toBe(0)
    expect(await db.segments.get('s1')).toMatchObject({
      note: 'appareil A', updatedAt: T + 20, syncState: 'pending',
    })
  })

  it('applique la modification distante la plus récente', async () => {
    await db.segments.put(segment({ note: 'appareil A', updatedAt: T + 10, syncState: 'pending' }))
    const applied = await applyRemoteRows(segmentTable, [
      segment({ note: 'appareil B', updatedAt: T + 20, syncState: 'synced' }),
    ])
    expect(applied).toBe(1)
    expect(await db.segments.get('s1')).toMatchObject({
      note: 'appareil B', updatedAt: T + 20, syncState: 'synced',
    })
  })
})

describe('erreurs affichables', () => {
  it('ne révèle jamais un jeton ou une URL sensible', () => {
    const message = sanitizeSyncError(
      new Error('JWT eySecret token rejected by https://private.example.test/path'),
    )
    expect(message).toBe('La session a expiré. Reconnecte-toi puis réessaie.')
    expect(message).not.toContain('eySecret')
    expect(message).not.toContain('https://')
  })

  it('explique une panne réseau sans détail technique', () => {
    expect(sanitizeSyncError(new TypeError('Failed to fetch'))).toContain('inaccessible')
  })

  it('distingue un schéma absent, une règle RLS et une donnée invalide', () => {
    expect(classifySyncError({ code: 'PGRST205', message: 'table missing' })).toBe('schema')
    expect(classifySyncError({ code: '42501', message: 'row-level security policy' })).toBe(
      'permission',
    )
    expect(classifySyncError({ code: '23503', message: 'violates foreign key' })).toBe(
      'invalid-data',
    )
  })

  it('produit un diagnostic sans recopier le message distant', () => {
    const diagnostic = formatSyncDiagnostic([
      { table: 'stock_shortages', operation: 'pull', kind: 'schema' },
    ])
    expect(diagnostic).toBe('stock_shortages · lecture · schéma incompatible')
    expect(diagnostic).not.toContain('token')
    expect(diagnostic).not.toContain('https://')
  })
})

describe('tolérance aux migrations manquantes', () => {
  it('synchronise les anciennes tables et garde la nouvelle table en attente', async () => {
    const workday: Workday = {
      id: 'w-partial',
      date: '2026-08-04',
      status: 'open',
      startedAt: T,
      updatedAt: T,
      syncState: 'pending',
    }
    const shortage: StockShortage = {
      id: 'shortage-partial',
      workdayId: workday.id,
      orderId: 'o-partial',
      at: T,
      quantity: 1,
      resolved: false,
      updatedAt: T,
      syncState: 'pending',
    }
    await db.workdays.put(workday)
    await db.stockShortages.put(shortage)
    await setMeta('sync:cursor:stock_shortages', T - 1)

    const broken = fakeClient('stock_shortages')
    const partial = await syncTables(broken.client, [workdayTable, shortageTable])

    expect(partial).toMatchObject({ pulled: 0, pushed: 1 })
    expect(partial.failures).toEqual([
      { table: 'stock_shortages', operation: 'pull', kind: 'schema' },
    ])
    expect(await db.workdays.get(workday.id)).toMatchObject({ syncState: 'synced' })
    expect(await db.stockShortages.get(shortage.id)).toMatchObject({ syncState: 'pending' })
    expect(await getMeta('sync:cursor:stock_shortages', 0)).toBe(T - 1)

    const repaired = fakeClient()
    const retry = await syncTables(repaired.client, [workdayTable, shortageTable])
    expect(retry).toMatchObject({ pulled: 0, pushed: 1, failures: [] })
    expect(await db.stockShortages.get(shortage.id)).toMatchObject({ syncState: 'synced' })
    expect(repaired.upserts).toEqual(['stock_shortages'])

    await syncTables(repaired.client, [workdayTable, shortageTable])
    expect(repaired.upserts).toEqual(['stock_shortages'])
  })
})
