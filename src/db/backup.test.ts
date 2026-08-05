import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildBackup, restoreBackup } from './backup'
import { db } from './db'
import type { Segment, StockShortage, Workday } from '../core/types'

const T = new Date(2026, 6, 31, 13, 0, 0).getTime()

beforeEach(async () => {
  await db.delete()
  await db.open()
})

function workday(over: Partial<Workday> = {}): Workday {
  return {
    id: 'w1',
    date: '2026-07-31',
    status: 'closed',
    startedAt: T,
    endedAt: T + 3600_000,
    updatedAt: T,
    syncState: 'synced',
    ...over,
  }
}

function segment(over: Partial<Segment> = {}): Segment {
  return {
    id: 's1',
    workdayId: 'w1',
    type: 'picking',
    startedAt: T,
    endedAt: T + 600_000,
    updatedAt: T,
    syncState: 'synced',
    ...over,
  }
}

function shortage(over: Partial<StockShortage> = {}): StockShortage {
  return {
    id: 'r1',
    workdayId: 'w1',
    orderId: 'o1',
    at: T + 300_000,
    quantity: 4,
    resolved: false,
    updatedAt: T,
    syncState: 'synced',
    ...over,
  }
}

describe('export', () => {
  it('emporte tout et annonce ce qu’il contient', async () => {
    await db.workdays.put(workday())
    await db.segments.bulkPut([segment(), segment({ id: 's2' })])
    await db.stockShortages.put(shortage())

    const backup = await buildBackup()
    expect(backup.format).toBe('prepatrack-backup')
    expect(backup.counts).toMatchObject({ workdays: 1, segments: 2, stockShortages: 1 })
    expect(backup.workdays[0].id).toBe('w1')
    // Les réglages voyagent avec, pour ne pas avoir à les refaire à la main.
    expect(backup.settings.targetRate).toBe(110)
    expect('recordingChunks' in backup).toBe(false)
  })

  it('reste relisible après un aller-retour par JSON', async () => {
    await db.workdays.put(workday())
    await db.segments.put(segment())
    await db.stockShortages.put(shortage())
    const json = JSON.stringify(await buildBackup())

    await db.delete()
    await db.open()
    expect(await db.workdays.count()).toBe(0)

    const result = await restoreBackup(json)
    expect(result.added).toBe(3)

    const restored = await db.segments.get('s1')
    expect(restored?.startedAt).toBe(T)
    expect(restored?.endedAt).toBe(T + 600_000)
    expect(await db.stockShortages.get('r1')).toMatchObject({ quantity: 4, syncState: 'pending' })
  })
})

describe('restauration', () => {
  it('marque tout à renvoyer vers la synchro', async () => {
    await db.workdays.put(workday())
    const json = JSON.stringify(await buildBackup())
    await db.delete()
    await db.open()

    await restoreBackup(json)
    // Sans cela, une base restaurée resterait invisible de l'autre appareil.
    expect((await db.workdays.get('w1'))?.syncState).toBe('pending')
  })

  it('accepte une ancienne sauvegarde sans rupture de stock', async () => {
    await db.workdays.put(workday())
    const backup = await buildBackup()
    delete backup.stockShortages

    await db.delete()
    await db.open()
    await expect(restoreBackup(JSON.stringify(backup))).resolves.toMatchObject({ added: 1 })
  })

  it('ne remplace jamais une donnée locale plus récente', async () => {
    await db.segments.put(segment({ note: 'version du fichier' }))
    const json = JSON.stringify(await buildBackup())

    // La journée a continué depuis l'export : la correction locale est plus récente.
    await db.segments.put(
      segment({ note: 'correction faite après', updatedAt: T + 60_000 }),
    )

    const result = await restoreBackup(json)
    expect(result.skipped).toBe(1)
    expect(result.updated).toBe(0)
    // Restaurer une vieille sauvegarde ne doit pas effacer le travail d'après.
    expect((await db.segments.get('s1'))?.note).toBe('correction faite après')
  })

  it('met à jour ce qui est plus ancien localement', async () => {
    await db.segments.put(segment({ note: 'récent', updatedAt: T + 60_000 }))
    const json = JSON.stringify(await buildBackup())
    await db.segments.put(segment({ note: 'ancien', updatedAt: T }))

    const result = await restoreBackup(json)
    expect(result.updated).toBe(1)
    expect((await db.segments.get('s1'))?.note).toBe('récent')
  })

  it('refuse un fichier qui n’en est pas un', async () => {
    await expect(restoreBackup('pas du json')).rejects.toThrow(/pas lisible/)
    await expect(restoreBackup('{"format":"autre chose"}')).rejects.toThrow(
      /sauvegarde PrepaTrack/,
    )
    // Un refus ne doit rien avoir touché.
    expect(await db.workdays.count()).toBe(0)
  })
})
