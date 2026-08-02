import type { SupabaseClient } from '@supabase/supabase-js'
import { db, getMeta, setMeta } from '../db/db'
import { getClient } from './client'
import { SYNC_TABLES, type AnySyncTable, type SyncRow } from './tables'

/**
 * Moteur de synchronisation.
 *
 * Règle d'or : **on descend avant de remonter**. Sans cela, une correction faite
 * le soir sur le PC serait écrasée par la version d'origine restée en attente
 * sur le téléphone — dont l'horodatage, plus ancien, ne serait pourtant jamais
 * examiné puisque l'envoi écrase sans condition. En descendant d'abord, la
 * correction arrive localement, gagne au « dernier écrit » et la ligne du
 * téléphone cesse d'être en attente.
 *
 * Aucune de ces fonctions ne doit être bloquante ni obligatoire : l'application
 * fonctionne intégralement sans réseau et sans compte.
 */

const PAGE_SIZE = 500
const PUSH_CHUNK = 200

export type SyncState =
  | 'unconfigured' // pas d'identifiants Supabase saisis
  | 'signed_out' // configuré mais pas connecté
  | 'offline' // pas de réseau
  | 'running'
  | 'ok'
  | 'error'

export interface SyncOutcome {
  state: SyncState
  pulled: number
  pushed: number
  at: number
  error?: string
}

let running = false

export async function countPending(): Promise<number> {
  const counts = await Promise.all(
    SYNC_TABLES.map((t) => t.table().where('syncState').equals('pending').count()),
  )
  return counts.reduce((a, b) => a + b, 0)
}

export async function getLastSyncAt(): Promise<number | undefined> {
  return getMeta<number | undefined>('sync:lastAt', undefined)
}

/** Remet les curseurs à zéro : tout sera redescendu au prochain passage. */
export async function resetCursors(): Promise<void> {
  await Promise.all(SYNC_TABLES.map((t) => setMeta(cursorKey(t), 0)))
  await setMeta('sync:lastAt', undefined)
}

function cursorKey(table: AnySyncTable): string {
  return `sync:cursor:${table.remote}`
}

export async function runSync(): Promise<SyncOutcome> {
  const at = Date.now()
  if (running) return { state: 'running', pulled: 0, pushed: 0, at }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { state: 'offline', pulled: 0, pushed: 0, at }
  }

  const client = await getClient()
  if (!client) return { state: 'unconfigured', pulled: 0, pushed: 0, at }

  const { data: sessionData } = await client.auth.getSession()
  if (!sessionData.session) return { state: 'signed_out', pulled: 0, pushed: 0, at }

  running = true
  let pulled = 0
  let pushed = 0
  try {
    for (const table of SYNC_TABLES) {
      pulled += await pullTable(client, table)
    }
    for (const table of SYNC_TABLES) {
      pushed += await pushTable(client, table)
    }
    const finishedAt = Date.now()
    await setMeta('sync:lastAt', finishedAt)
    return { state: 'ok', pulled, pushed, at: finishedAt }
  } catch (error) {
    return {
      state: 'error',
      pulled,
      pushed,
      at: Date.now(),
      error: describe(error),
    }
  } finally {
    running = false
  }
}

// --- Descente -------------------------------------------------------------

async function pullTable(client: SupabaseClient, table: AnySyncTable): Promise<number> {
  const cursor = await getMeta<number>(cursorKey(table), 0)
  let applied = 0
  let maxSeen = cursor
  let from = 0

  for (;;) {
    const { data, error } = await client
      .from(table.remote)
      .select('*')
      .gt('updated_at', cursor)
      .order('updated_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error
    if (!data || data.length === 0) break

    const rows = data.map((row) => table.fromRow(row as Record<string, unknown>))
    applied += await applyRemoteRows(table, rows)
    for (const row of rows) maxSeen = Math.max(maxSeen, row.updatedAt)

    if (data.length < PAGE_SIZE) break
    // Pagination par décalage : plusieurs lignes peuvent partager le même
    // horodatage à la milliseconde (un effacement global, par exemple), un
    // curseur temporel seul en sauterait.
    from += PAGE_SIZE
  }

  if (maxSeen > cursor) await setMeta(cursorKey(table), maxSeen)
  return applied
}

async function applyRemoteRows(table: AnySyncTable, rows: SyncRow[]): Promise<number> {
  const local = table.table()
  let applied = 0

  await db.transaction('rw', local, async () => {
    const existing = await local.bulkGet(rows.map((r) => r.id))
    const toWrite: SyncRow[] = []

    rows.forEach((remote, i) => {
      const current = existing[i]
      // Dernier écrit gagnant. À égalité d'horodatage on ne touche à rien :
      // c'est la ligne qu'on vient nous-même d'envoyer et qui nous revient.
      if (current && current.updatedAt >= remote.updatedAt) return
      toWrite.push(remote)
    })

    if (toWrite.length > 0) {
      await local.bulkPut(toWrite)
      applied = toWrite.length
    }
  })

  return applied
}

// --- Remontée -------------------------------------------------------------

async function pushTable(client: SupabaseClient, table: AnySyncTable): Promise<number> {
  const local = table.table()
  const pending = await local.where('syncState').equals('pending').toArray()
  if (pending.length === 0) return 0

  let sent = 0
  for (let i = 0; i < pending.length; i += PUSH_CHUNK) {
    const chunk = pending.slice(i, i + PUSH_CHUNK)
    const { error } = await client
      .from(table.remote)
      .upsert(chunk.map(table.toRow), { onConflict: 'id' })
    if (error) throw error

    // On retient la version envoyée pour chaque ligne : si elle a été modifiée
    // pendant l'envoi, elle doit rester en attente et repartir au tour suivant.
    const versions = new Map(chunk.map((row) => [row.id, row.updatedAt]))
    await local
      .where('id')
      .anyOf([...versions.keys()])
      .modify((row) => {
        if (versions.get(row.id) === row.updatedAt) row.syncState = 'synced'
      })

    sent += chunk.length
  }

  return sent
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

/** Message court et compréhensible pour l'écran de synchro. */
export function describeState(state: SyncState): string {
  switch (state) {
    case 'unconfigured':
      return 'Synchro non configurée'
    case 'signed_out':
      return 'Non connecté'
    case 'offline':
      return 'Hors ligne — envoi dès le retour du réseau'
    case 'running':
      return 'Synchro en cours…'
    case 'ok':
      return 'À jour'
    case 'error':
      return 'Échec de la synchro'
  }
}
