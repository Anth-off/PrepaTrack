import Dexie, { type Table } from 'dexie'
import type { ColisEvent, Order, Segment, Settings, StockShortage, Workday } from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'

/**
 * IndexedDB est la source de vérité de l'application. Rien ne dépend du réseau :
 * l'entrepôt n'a pas de couverture, l'app doit être intégralement fonctionnelle
 * en mode avion. La synchro Supabase (lot 2) ne fera que recopier ces tables.
 */
/** Petites valeurs de service : réglages de synchro, date du dernier pull… */
export interface MetaRow {
  key: string
  value: unknown
}

export class PrepaDB extends Dexie {
  workdays!: Table<Workday, string>
  orders!: Table<Order, string>
  segments!: Table<Segment, string>
  colisEvents!: Table<ColisEvent, string>
  stockShortages!: Table<StockShortage, string>
  settings!: Table<Settings, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('prepatrack')
    this.version(1).stores({
      workdays: 'id, date, status, startedAt, syncState',
      orders: 'id, workdayId, status, startedAt, syncState',
      segments: 'id, workdayId, orderId, type, startedAt, syncState',
      colisEvents: 'id, workdayId, orderId, at, syncState',
      settings: 'id',
    })
    this.version(2).stores({
      meta: 'key',
    })
    this.version(3).stores({
      stockShortages: 'id, workdayId, orderId, at, syncState',
    })
  }
}

export const db = new PrepaDB()

/**
 * Lecture seule, volontairement : cette fonction est appelée depuis des
 * `useLiveQuery`, qui s'exécutent dans une transaction en lecture seule. Y
 * écrire une ligne d'initialisation ferait échouer toute la requête. Tant que
 * rien n'a été personnalisé, les valeurs par défaut suffisent ; la ligne est
 * créée au premier `saveSettings`.
 */
export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('settings')
  // Fusion avec les valeurs par défaut : une option ajoutée dans une version
  // ultérieure ne doit pas revenir `undefined` sur une base existante.
  return existing ? { ...DEFAULT_SETTINGS, ...existing } : DEFAULT_SETTINGS
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next = { ...current, ...patch, id: 'settings' as const, updatedAt: Date.now() }
  await db.settings.put(next)
  return next
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

/**
 * Efface toutes les journées enregistrées. La suppression est logique et non
 * physique, volontairement : un effacement purement local serait annulé au
 * premier pull, le serveur renvoyant gentiment tout ce qu'on vient de jeter.
 * Marquées `deletedAt` + `pending`, les lignes propagent au contraire leur
 * suppression à l'autre appareil.
 */
export async function wipeAll(): Promise<void> {
  const at = Date.now()
  await db.transaction(
    'rw',
    [db.workdays, db.orders, db.segments, db.colisEvents, db.stockShortages],
    async () => {
      for (const table of [
        db.workdays,
        db.orders,
        db.segments,
        db.colisEvents,
        db.stockShortages,
      ]) {
        // `modify()` réécrit en place, sans charger toute la table en mémoire.
        await (
          table as Table<
            { deletedAt?: number; syncState: string; updatedAt: number },
            string
          >
        )
          .toCollection()
          .modify((row) => {
            row.deletedAt = at
            // `updatedAt` doit avancer, sinon l'autre appareil, dont le curseur
            // est plus récent, ne verrait jamais passer la suppression.
            row.updatedAt = at
            row.syncState = 'pending'
          })
      }
    },
  )
}

/** Identifiant unique, sans dépendance externe et sûr hors HTTPS. */
export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
