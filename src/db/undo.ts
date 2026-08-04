import type { Table } from 'dexie'
import type { ColisEvent, Order, OrderPallet, Segment, StockShortage, Workday } from '../core/types'
import { db } from './db'
import { loadSnapshot } from './repo'

export const UNDO_WINDOW_MS = 10_000
const UNDO_META_KEY = 'undo:last-action'

type UndoTable = 'workdays' | 'orders' | 'orderPallets' | 'segments' | 'colisEvents' | 'stockShortages'
type UndoRow = Workday | Order | OrderPallet | Segment | ColisEvent | StockShortage

interface UndoChange {
  table: UndoTable
  id: string
  before?: UndoRow
  after?: UndoRow
}

interface UndoCheckpoint {
  label: string
  expiresAt: number
  changes: UndoChange[]
}

export interface UndoNotice {
  label: string
  expiresAt: number
}

type WorkdayState = Record<UndoTable, UndoRow[]>

let operationQueue: Promise<void> = Promise.resolve()

/**
 * Exécute une écriture puis mémorise uniquement les lignes qu'elle a changées.
 * L'état précédent reste local dans `meta` : il n'est jamais synchronisé. En
 * revanche, l'opération inverse réécrit les lignes métier en `pending`, ce qui
 * la propage normalement à l'autre appareil.
 */
export function performUndoable(
  label: string,
  action: () => Promise<unknown>,
  at: number = Date.now(),
): Promise<UndoNotice | undefined> {
  return enqueue(() =>
    db.transaction(
      'rw',
      [db.workdays, db.orders, db.orderPallets, db.segments, db.colisEvents, db.stockShortages, db.meta],
      async () => {
        await clearUndoCheckpointInternal()
        const snap = await loadSnapshot()
        const workdayId = snap.workday?.id

        if (!workdayId) {
          await action()
          return undefined
        }

        const before = await capture(workdayId)
        await action()
        const after = await capture(workdayId)
        const changes = diff(before, after)
        if (changes.length === 0) return undefined

        const checkpoint: UndoCheckpoint = {
          label,
          expiresAt: at + UNDO_WINDOW_MS,
          changes,
        }
        await db.meta.put({ key: UNDO_META_KEY, value: checkpoint })
        return { label: checkpoint.label, expiresAt: checkpoint.expiresAt }
      },
    ),
  )
}

export async function getUndoNotice(at: number = Date.now()): Promise<UndoNotice | undefined> {
  await operationQueue
  const checkpoint = await readCheckpoint()
  if (!checkpoint) return undefined
  if (checkpoint.expiresAt <= at) {
    await clearUndoCheckpointInternal()
    return undefined
  }
  return { label: checkpoint.label, expiresAt: checkpoint.expiresAt }
}

export function clearUndoCheckpoint(): Promise<void> {
  return enqueue(clearUndoCheckpointInternal)
}

/** Sérialise aussi les actions non annulables et invalide le bandeau précédent. */
export function performWithoutUndo<T>(action: () => Promise<T>): Promise<T> {
  return enqueue(async () => {
    await clearUndoCheckpointInternal()
    return action()
  })
}

async function clearUndoCheckpointInternal(): Promise<void> {
  await db.meta.delete(UNDO_META_KEY)
}

/**
 * Restaure la dernière action si aucune de ses lignes n'a changé depuis. Une
 * synchronisation qui ne fait que passer `pending` à `synced` reste compatible ;
 * une vraie modification concurrente annule prudemment la possibilité d'undo.
 */
export function undoLastAction(at: number = Date.now()): Promise<boolean> {
  return enqueue(() => undoLastActionInternal(at))
}

async function undoLastActionInternal(at: number): Promise<boolean> {
  const checkpoint = await readCheckpoint()
  if (!checkpoint || checkpoint.expiresAt <= at) {
    await clearUndoCheckpointInternal()
    return false
  }

  return db.transaction(
    'rw',
    [db.workdays, db.orders, db.orderPallets, db.segments, db.colisEvents, db.stockShortages, db.meta],
    async () => {
      const currentRows = await Promise.all(
        checkpoint.changes.map((change) => undoTable(change.table).get(change.id)),
      )

      const unchanged = checkpoint.changes.every((change, index) =>
        sameBusinessValue(currentRows[index], change.after),
      )
      if (!unchanged) {
        await db.meta.delete(UNDO_META_KEY)
        return false
      }

      const writeAt = Math.max(
        at,
        ...currentRows.map((row) => (row?.updatedAt ?? 0) + 1),
      )

      for (let index = 0; index < checkpoint.changes.length; index += 1) {
        const change = checkpoint.changes[index]
        const table = undoTable(change.table)
        const current = currentRows[index]

        if (change.before) {
          await table.put({
            ...change.before,
            updatedAt: writeAt,
            syncState: 'pending',
          })
        } else if (current) {
          // Une ligne créée par l'action doit propager sa disparition au serveur.
          await table.put({
            ...current,
            deletedAt: writeAt,
            updatedAt: writeAt,
            syncState: 'pending',
          })
        }
      }

      await db.meta.delete(UNDO_META_KEY)
      return true
    },
  )
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation)
  // Une action refusée ne doit pas bloquer toutes les suivantes.
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function readCheckpoint(): Promise<UndoCheckpoint | undefined> {
  const row = await db.meta.get(UNDO_META_KEY)
  return row?.value as UndoCheckpoint | undefined
}

async function capture(workdayId: string): Promise<WorkdayState> {
  const [workday, orders, orderPallets, segments, colisEvents, stockShortages] = await Promise.all([
    db.workdays.get(workdayId),
    db.orders.where('workdayId').equals(workdayId).toArray(),
    db.orderPallets.where('workdayId').equals(workdayId).toArray(),
    db.segments.where('workdayId').equals(workdayId).toArray(),
    db.colisEvents.where('workdayId').equals(workdayId).toArray(),
    db.stockShortages.where('workdayId').equals(workdayId).toArray(),
  ])
  return {
    workdays: workday ? [workday] : [],
    orders,
    orderPallets,
    segments,
    colisEvents,
    stockShortages,
  }
}

function diff(before: WorkdayState, after: WorkdayState): UndoChange[] {
  const changes: UndoChange[] = []
  for (const table of Object.keys(before) as UndoTable[]) {
    const beforeById = new Map(before[table].map((row) => [row.id, row]))
    const afterById = new Map(after[table].map((row) => [row.id, row]))
    const ids = new Set([...beforeById.keys(), ...afterById.keys()])
    for (const id of ids) {
      const previous = beforeById.get(id)
      const next = afterById.get(id)
      if (!sameBusinessValue(previous, next)) {
        changes.push({ table, id, before: previous, after: next })
      }
    }
  }
  return changes
}

/** Les champs de service peuvent changer pendant une synchro sans changer l'action. */
function sameBusinessValue(a: UndoRow | undefined, b: UndoRow | undefined): boolean {
  if (!a || !b) return a === b
  return JSON.stringify(businessValue(a)) === JSON.stringify(businessValue(b))
}

function businessValue(row: UndoRow): UndoRow {
  return { ...row, updatedAt: 0, syncState: 'pending' }
}

function undoTable(name: UndoTable): Table<UndoRow, string> {
  return db[name] as unknown as Table<UndoRow, string>
}
