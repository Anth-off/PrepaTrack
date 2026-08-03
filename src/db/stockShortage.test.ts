import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  createStockShortage,
  claimOrphans,
  deleteStockShortage,
  deleteWorkday,
  endBriefing,
  setStockShortageResolved,
  shortageTotal,
  startDay,
  startOrder,
  stockShortagesFor,
  updateStockShortage,
  unexplainedColis,
} from './repo'
import { SYNC_TABLES } from '../sync/tables'

const at = (minute: number) => new Date(2026, 7, 4, 8, minute).getTime()

beforeEach(async () => {
  await db.delete()
  await db.open()
})

async function beginOrder() {
  await startDay(at(0))
  await endBriefing(at(5))
  return startOrder(
    { colisPlanned: 100, linesCount: 20, orderType: 'normale' },
    at(10),
  )
}

describe('ruptures de stock', () => {
  it('n’existe que pendant une commande et exige une quantité positive', async () => {
    expect(await createStockShortage({ quantity: 2 }, at(1))).toBeUndefined()
    await beginOrder()
    await expect(createStockShortage({ quantity: 0 }, at(11))).rejects.toThrow(
      'strictement positive',
    )
    expect(await db.stockShortages.count()).toBe(0)
  })

  it('compte plusieurs appuis hors stock sans augmenter les colis préparés', async () => {
    const order = await beginOrder()
    const first = await createStockShortage({ quantity: 1 }, at(11))
    await createStockShortage({ quantity: 1 }, at(12))

    const rows = await stockShortagesFor(order!.workdayId)
    expect(rows).toHaveLength(2)
    expect(first).toMatchObject({
      orderId: order!.id,
      quantity: 1,
      resolved: false,
      syncState: 'pending',
    })
    expect(shortageTotal(rows, order!.id)).toBe(2)
    expect(unexplainedColis(100, 98, rows, order!.id)).toBe(0)
    expect(unexplainedColis(100, 95, rows, order!.id)).toBe(3)
  })

  it('corrige, résout puis supprime logiquement sans perdre la synchronisation', async () => {
    const order = await beginOrder()
    const shortage = await createStockShortage({ quantity: 4 }, at(11))

    await updateStockShortage(shortage!.id, { quantity: 6 })
    await setStockShortageResolved(shortage!.id, true)
    expect(await db.stockShortages.get(shortage!.id)).toMatchObject({
      quantity: 6,
      resolved: true,
      syncState: 'pending',
    })

    await deleteStockShortage(shortage!.id, at(20))
    expect(await stockShortagesFor(order!.workdayId)).toEqual([])
    expect(await db.stockShortages.get(shortage!.id)).toMatchObject({
      deletedAt: at(20),
      syncState: 'pending',
    })
  })

  it('conserve le même identifiant dans l’aller-retour Supabase', async () => {
    await beginOrder()
    const shortage = await createStockShortage({ quantity: 7 }, at(11))
    const table = SYNC_TABLES.find((candidate) => candidate.remote === 'stock_shortages')!
    const remote = table.toRow(shortage!)
    const returned = table.fromRow({ ...remote, user_id: 'owner-1' })

    expect(remote).toMatchObject({ quantity: 7 })
    expect(returned).toMatchObject({
      id: shortage!.id,
      orderId: shortage!.orderId,
      quantity: 7,
      syncState: 'synced',
    })
  })

  it('suit le propriétaire et la suppression logique de sa journée', async () => {
    const order = await beginOrder()
    const shortage = await createStockShortage({ quantity: 2 }, at(11))

    expect(await claimOrphans('owner-1')).toBeGreaterThan(0)
    expect((await db.stockShortages.get(shortage!.id))?.ownerId).toBe('owner-1')

    await deleteWorkday(order!.workdayId)
    expect(await db.stockShortages.get(shortage!.id)).toMatchObject({
      syncState: 'pending',
    })
    expect((await db.stockShortages.get(shortage!.id))?.deletedAt).toBeDefined()
  })
})
