import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveView } from '../core/machine'
import { MINUTE } from '../core/time'
import { db } from './db'
import {
  addColis,
  advanceOrder,
  colisEventsFor,
  createStockShortage,
  endBriefing,
  endInterruption,
  loadSnapshot,
  startDay,
  startInterruption,
  startOrder,
  stockShortagesFor,
} from './repo'
import {
  getUndoNotice,
  performUndoable,
  performWithoutUndo,
  UNDO_WINDOW_MS,
  undoLastAction,
} from './undo'

const START = new Date(2026, 7, 4, 8, 0, 0).getTime()
const at = (minutes: number) => START + minutes * MINUTE

beforeEach(async () => {
  await db.delete()
  await db.open()
})

async function beginPicking(): Promise<string> {
  await startDay(at(0))
  await endBriefing(at(5))
  const order = await startOrder(
    { colisPlanned: 100, linesCount: 25, orderType: 'normale' },
    at(10),
  )
  await advanceOrder(at(15))
  return order!.id
}

describe('annulation de la dernière action', () => {
  it('annule une variation du compteur par une suppression synchronisable', async () => {
    const orderId = await beginPicking()

    const notice = await performUndoable('5 colis ajoutés', () => addColis(5, at(20)), at(20))
    expect(notice?.label).toBe('5 colis ajoutés')
    expect(await colisEventsFor((await loadSnapshot()).workday!.id)).toHaveLength(1)

    expect(await undoLastAction(at(20) + 1_000)).toBe(true)
    expect(await colisEventsFor((await loadSnapshot()).workday!.id)).toHaveLength(0)

    const raw = await db.colisEvents.where('orderId').equals(orderId).first()
    expect(raw?.deletedAt).toBeDefined()
    expect(raw?.syncState).toBe('pending')
  })

  it('annule un appui hors stock sans toucher au compteur préparé', async () => {
    const orderId = await beginPicking()

    await performUndoable(
      '1 colis hors stock',
      () => createStockShortage({ quantity: 1 }, at(20)),
      at(20),
    )
    const workdayId = (await loadSnapshot()).workday!.id
    expect(await stockShortagesFor(workdayId)).toHaveLength(1)
    expect(await colisEventsFor(workdayId)).toHaveLength(0)

    expect(await undoLastAction(at(20) + 1_000)).toBe(true)
    expect(await stockShortagesFor(workdayId)).toHaveLength(0)
    expect(await colisEventsFor(workdayId)).toHaveLength(0)

    const raw = await db.stockShortages.where('orderId').equals(orderId).first()
    expect(raw).toMatchObject({ syncState: 'pending' })
    expect(raw?.deletedAt).toBeDefined()
  })

  it('annule le démarrage d’un trajet et rouvre la prépa', async () => {
    await beginPicking()

    await performUndoable('Trajet', () => startInterruption('travel', at(20)), at(20))
    expect(deriveView(await loadSnapshot()).active?.type).toBe('travel')

    expect(await undoLastAction(at(20) + 1_000)).toBe(true)
    const view = deriveView(await loadSnapshot())
    expect(view.phase).toBe('picking')
    expect(view.active?.endedAt).toBeUndefined()
    expect(view.active?.syncState).toBe('pending')

    const travel = await db.segments.where('type').equals('travel').first()
    expect(travel?.deletedAt).toBeDefined()
    expect(travel?.syncState).toBe('pending')
  })

  it('annule la fin d’une interruption et la restaure avec sa pile', async () => {
    await beginPicking()
    await startInterruption('travel', at(20))

    await performUndoable('Fin du trajet', () => endInterruption(at(25)), at(25))
    expect(deriveView(await loadSnapshot()).phase).toBe('picking')

    expect(await undoLastAction(at(25) + 1_000)).toBe(true)
    const view = deriveView(await loadSnapshot())
    expect(view.phase).toBe('interrupted')
    expect(view.active?.type).toBe('travel')
    expect(view.resuming).toBe('picking')
  })

  it('annule une transition de commande encore réversible', async () => {
    await beginPicking()
    await performUndoable('Fin de la prépa', () => advanceOrder(at(20)), at(20))
    expect(deriveView(await loadSnapshot()).phase).toBe('wrapping')

    expect(await undoLastAction(at(20) + 1_000)).toBe(true)
    expect(deriveView(await loadSnapshot()).phase).toBe('picking')
  })

  it('reste annulable si la synchronisation ne change que les champs de service', async () => {
    await beginPicking()
    await performUndoable('Trajet', () => startInterruption('travel', at(20)), at(20))

    await db.segments.toCollection().modify((segment) => {
      segment.syncState = 'synced'
      segment.updatedAt += 1
    })

    expect(await undoLastAction(at(20) + 1_000)).toBe(true)
    const rows = await db.segments.toArray()
    const active = rows.find((row) => !row.deletedAt && row.endedAt === undefined)
    expect(active?.type).toBe('picking')
    expect(rows.filter((row) => row.syncState === 'pending')).toHaveLength(2)
  })

  it('refuse de recouvrir une vraie modification concurrente', async () => {
    await beginPicking()
    await performUndoable('1 colis ajouté', () => addColis(1, at(20)), at(20))
    const event = (await db.colisEvents.toArray())[0]
    await db.colisEvents.put({ ...event, delta: 7, updatedAt: event.updatedAt + 1 })

    expect(await undoLastAction(at(20) + 1_000)).toBe(false)
    expect((await db.colisEvents.get(event.id))?.delta).toBe(7)
  })

  it('expire après la fenêtre et ne touche plus aux données', async () => {
    await beginPicking()
    await performUndoable('1 colis ajouté', () => addColis(1, at(20)), at(20))

    expect(await getUndoNotice(at(20) + UNDO_WINDOW_MS - 1)).toBeDefined()
    expect(await undoLastAction(at(20) + UNDO_WINDOW_MS + 1)).toBe(false)
    expect(await colisEventsFor((await loadSnapshot()).workday!.id)).toHaveLength(1)
  })

  it('ne conserve que la plus récente de deux actions', async () => {
    await beginPicking()
    const first = performUndoable('1 colis ajouté', () => addColis(1, at(20)), at(20))
    const second = performUndoable('5 colis ajoutés', () => addColis(5, at(21)), at(21))
    await Promise.all([first, second])

    expect(await undoLastAction(at(21) + 1_000)).toBe(true)
    const events = await colisEventsFor((await loadSnapshot()).workday!.id)
    expect(events.map((event) => event.delta)).toEqual([1])
  })

  it('reste atomique si l’action échoue et accepte ensuite une nouvelle action', async () => {
    await beginPicking()

    await expect(
      performUndoable('Action invalide', async () => {
        await addColis(3, at(20))
        throw new Error('échec simulé')
      }, at(20)),
    ).rejects.toThrow('échec simulé')

    expect(await colisEventsFor((await loadSnapshot()).workday!.id)).toHaveLength(0)
    expect(await getUndoNotice(at(20) + 1_000)).toBeUndefined()

    await performUndoable('1 colis ajouté', () => addColis(1, at(21)), at(21))
    expect(await undoLastAction(at(21) + 1_000)).toBe(true)
  })

  it('invalide l’annulation précédente avant une action non annulable', async () => {
    await beginPicking()
    await performUndoable('1 colis ajouté', () => addColis(1, at(20)), at(20))

    await performWithoutUndo(async () => undefined)

    expect(await getUndoNotice(at(20) + 1_000)).toBeUndefined()
    expect(await undoLastAction(at(20) + 1_000)).toBe(false)
    expect(await colisEventsFor((await loadSnapshot()).workday!.id)).toHaveLength(1)
  })
})
