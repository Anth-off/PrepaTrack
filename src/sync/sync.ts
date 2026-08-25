import type { SupabaseClient } from '@supabase/supabase-js'
import { db, getMeta, setMeta } from '../db/db'
import { getClient, recoverClientAuth } from './client'
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
  /** Diagnostic volontairement borné à des valeurs non sensibles. */
  diagnostic?: string
  failures?: SyncFailure[]
}

export type SyncErrorKind =
  | 'network'
  | 'auth'
  | 'permission'
  | 'schema'
  | 'invalid-data'
  | 'unknown'
export type SyncOperation = 'pull' | 'push'

export interface SyncFailure {
  table: string
  operation: SyncOperation
  kind: SyncErrorKind
}

interface SyncProgress {
  pulled: number
  pushed: number
  failures: SyncFailure[]
}

let currentRun: Promise<SyncOutcome> | undefined

export async function countPending(): Promise<number> {
  const counts = await Promise.all(
    SYNC_TABLES.map((t) => t.table().where('syncState').equals('pending').count()),
  )
  return counts.reduce((a, b) => a + b, 0)
}

export async function getLastSyncAt(): Promise<number | undefined> {
  return getMeta<number | undefined>('sync:lastAt', undefined)
}

export async function getLastSyncAttemptAt(): Promise<number | undefined> {
  return getMeta<number | undefined>('sync:lastAttemptAt', undefined)
}

/** Remet les curseurs à zéro : tout sera redescendu au prochain passage. */
export async function resetCursors(): Promise<void> {
  await Promise.all(SYNC_TABLES.map((t) => setMeta(cursorKey(t), 0)))
  await setMeta('sync:lastAt', undefined)
  await setMeta('sync:lastAttemptAt', undefined)
}

function cursorKey(table: AnySyncTable): string {
  return `sync:cursor:${table.remote}`
}

export async function runSync(): Promise<SyncOutcome> {
  if (currentRun) return currentRun
  const run = performSync()
  currentRun = run
  try {
    return await run
  } finally {
    if (currentRun === run) currentRun = undefined
  }
}

async function performSync(): Promise<SyncOutcome> {
  const at = Date.now()
  await setMeta('sync:lastAttemptAt', at)

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { state: 'offline', pulled: 0, pushed: 0, at }
  }

  let pulled = 0
  let pushed = 0
  try {
    const client = await getClient()
    if (!client) return { state: 'unconfigured', pulled: 0, pushed: 0, at }

    let { data: sessionData } = await client.auth.getSession()
    if (!sessionData.session) {
      await recoverClientAuth(client)
      ;({ data: sessionData } = await client.auth.getSession())
    }
    if (!sessionData.session) return { state: 'signed_out', pulled: 0, pushed: 0, at }

    const progress = await syncTables(client)
    pulled = progress.pulled
    pushed = progress.pushed
    if (progress.failures.length > 0) {
      return {
        state: 'error',
        pulled,
        pushed,
        at: Date.now(),
        error: failureMessage(progress.failures),
        diagnostic: formatSyncDiagnostic(progress.failures),
        failures: progress.failures,
      }
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
      error: sanitizeSyncError(error),
    }
  }
}

/**
 * Synchronise chaque table indépendamment.
 *
 * La lecture précède toujours l'écriture d'une même table pour préserver le
 * dernier-écrit-gagnant. Une migration additive oubliée ne bloque toutefois
 * plus les tables compatibles : seules les lignes de la table en défaut restent
 * en attente. Les erreurs globales (réseau ou session) arrêtent la tentative
 * afin d'éviter cinq requêtes vouées au même échec.
 */
export async function syncTables(
  client: SupabaseClient,
  tables: AnySyncTable[] = SYNC_TABLES,
): Promise<SyncProgress> {
  let pulled = 0
  let pushed = 0
  const failures: SyncFailure[] = []

  for (const table of tables) {
    try {
      pulled += await pullTable(client, table)
    } catch (error) {
      const failure = syncFailure(table.remote, 'pull', error)
      failures.push(failure)
      if (failure.kind === 'network' || failure.kind === 'auth') break
      continue
    }

    try {
      pushed += await pushTable(client, table)
    } catch (error) {
      const failure = syncFailure(table.remote, 'push', error)
      failures.push(failure)
      if (failure.kind === 'network' || failure.kind === 'auth') break
    }
  }

  return { pulled, pushed, failures }
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

export async function applyRemoteRows(table: AnySyncTable, rows: SyncRow[]): Promise<number> {
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

export function sanitizeSyncError(error: unknown): string {
  return errorMessage(classifySyncError(error))
}

export function classifySyncError(error: unknown): SyncErrorKind {
  const record = typeof error === 'object' && error ? (error as Record<string, unknown>) : {}
  const code = String(record.code ?? '').toLowerCase()
  const status = Number(record.status ?? 0)
  const raw = error instanceof Error ? error.message : String(record.message ?? '')
  const message = `${raw} ${String(record.details ?? '')} ${String(record.hint ?? '')}`.toLowerCase()

  if (
    code === 'pgrst205' ||
    code === 'pgrst204' ||
    code === '42p01' ||
    code === '42703' ||
    message.includes('schema cache') ||
    (message.includes('relation') && message.includes('does not exist')) ||
    message.includes('could not find the table') ||
    message.includes('could not find the column')
  ) {
    return 'schema'
  }
  if (
    status === 401 ||
    code === 'pgrst301' ||
    message.includes('jwt') ||
    message.includes('token') ||
    message.includes('auth')
  ) {
    return 'auth'
  }
  if (
    status === 403 ||
    code === '42501' ||
    message.includes('permission') ||
    message.includes('policy') ||
    message.includes('denied') ||
    message.includes('row-level security')
  ) {
    return 'permission'
  }
  if (
    message.includes('network') || message.includes('fetch') || message.includes('timeout') ||
    message.includes('connexion')
  ) {
    return 'network'
  }
  if (/^(22|23)/.test(code) || message.includes('invalid input') || message.includes('violates')) {
    return 'invalid-data'
  }
  return 'unknown'
}

export function formatSyncDiagnostic(failures: SyncFailure[]): string {
  return failures
    .map(
      (failure) =>
        `${failure.table} · ${failure.operation === 'pull' ? 'lecture' : 'écriture'} · ${kindLabel(failure.kind)}`,
    )
    .join('\n')
}

function syncFailure(table: string, operation: SyncOperation, error: unknown): SyncFailure {
  return { table, operation, kind: classifySyncError(error) }
}

function failureMessage(failures: SyncFailure[]): string {
  if (failures.some((failure) => failure.kind === 'schema')) {
    return 'La base doit être mise à jour par le gestionnaire. Les données compatibles ont été synchronisées.'
  }
  return errorMessage(failures[0]?.kind ?? 'unknown')
}

function errorMessage(kind: SyncErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'La session a expiré. Reconnecte-toi puis réessaie.'
    case 'network':
      return 'Le service est momentanément inaccessible. Tes données restent sur cet appareil.'
    case 'permission':
      return 'Le compte ne permet pas cette synchronisation. Vérifie la connexion du profil.'
    case 'invalid-data':
      return 'Une donnée locale est incompatible. Elle reste en attente pour être corrigée.'
    case 'schema':
      return 'La base doit être mise à jour par le gestionnaire. Tes données locales sont conservées.'
    default:
      return 'La synchronisation a échoué. Tes données locales sont conservées.'
  }
}

function kindLabel(kind: SyncErrorKind): string {
  switch (kind) {
    case 'network':
      return 'réseau indisponible'
    case 'auth':
      return 'session invalide'
    case 'permission':
      return 'permission refusée'
    case 'schema':
      return 'schéma incompatible'
    case 'invalid-data':
      return 'donnée invalide'
    default:
      return 'erreur inconnue'
  }
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
