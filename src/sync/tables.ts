import type { Table } from 'dexie'
import { db } from '../db/db'
import type {
  ColisEvent,
  Order,
  OrderPallet,
  Segment,
  StockShortage,
  SupportKind,
  Workday,
} from '../core/types'
import { EMPTY_SUPPORTS } from '../core/types'
import { currentOwnerId, isKnownOwnerId } from './profile'

/**
 * Correspondance entre les tables locales (camelCase) et distantes (snake_case).
 *
 * Le point délicat est la conversion `null` → `undefined`. Postgres renvoie
 * `null` pour une colonne vide là où le code local teste `endedAt === undefined`
 * pour reconnaître un segment en cours. Sans cette conversion, une journée
 * redescendue du serveur n'aurait plus aucun segment ouvert et l'app se croirait
 * au repos en pleine prépa.
 */

type Row = Record<string, unknown>

function undef<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function optNum(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value)
}

/**
 * Propriétaire de la ligne. La clé est omise quand il est inconnu, pour laisser
 * jouer le `default auth.uid()` de la table : c'est le cas des lignes créées
 * avant toute connexion, qui reviennent ainsi au compte qui les envoie.
 * Un UUID connu (soi, ou un collègue du projet actuel) est transmis tel quel,
 * sans quoi un gestionnaire s'approprierait les journées de l'équipe. Un UUID
 * d'un ancien projet, lui, est remplacé par le compte courant : la base refuse
 * sinon la clé étrangère vers `auth.users`.
 */
function owner(item: { ownerId?: string }): Row {
  if (item.ownerId && isKnownOwnerId(item.ownerId)) return { user_id: item.ownerId }
  const me = currentOwnerId()
  return me ? { user_id: me } : {}
}

/** Le strict minimum dont le moteur de synchro a besoin sur une ligne. */
export interface SyncRow {
  id: string
  updatedAt: number
  syncState: 'pending' | 'synced'
}

interface SyncTable<T> {
  /** Nom de la table côté Supabase. */
  remote: string
  table: () => Table<T, string>
  toRow: (item: T) => Row
  fromRow: (row: Row) => T
}

/**
 * Vue effacée d'une table, tous types d'entités confondus. Le moteur de synchro
 * ne manipule que `id`, `updatedAt` et `syncState` : lui faire porter le type
 * exact de chaque entité l'obligerait à être générique de bout en bout, pour
 * une information dont il ne se sert jamais.
 */
export type AnySyncTable = SyncTable<SyncRow>

function define<T extends SyncRow>(table: SyncTable<T>): AnySyncTable {
  return table as unknown as AnySyncTable
}

const workdays: SyncTable<Workday> = {
  remote: 'workdays',
  table: () => db.workdays,
  toRow: (w) => ({
    id: w.id,
    date: w.date,
    status: w.status,
    started_at: w.startedAt,
    ended_at: w.endedAt ?? null,
    overtime_started_at: w.overtimeStartedAt ?? null,
    notes: w.notes ?? null,
    updated_at: w.updatedAt,
    deleted_at: w.deletedAt ?? null,
    ...owner(w),
  }),
  fromRow: (r) => ({
    id: String(r.id),
    date: String(r.date),
    status: r.status === 'closed' ? 'closed' : 'open',
    startedAt: num(r.started_at),
    endedAt: optNum(r.ended_at),
    overtimeStartedAt: optNum(r.overtime_started_at),
    notes: undef(r.notes as string | null),
    updatedAt: num(r.updated_at),
    deletedAt: optNum(r.deleted_at),
    ownerId: undef(r.user_id as string | null),
    syncState: 'synced',
  }),
}

const orders: SyncTable<Order> = {
  remote: 'orders',
  table: () => db.orders,
  toRow: (o) => ({
    id: o.id,
    workday_id: o.workdayId,
    status: o.status,
    order_type: o.orderType,
    colis_planned: o.colisPlanned,
    lines_count: o.linesCount,
    colis_actual: o.colisActual ?? null,
    supports: o.supports,
    store_count: o.storeCount ?? 1,
    active_pallet_id: o.activePalletId ?? null,
    started_at: o.startedAt,
    ended_at: o.endedAt ?? null,
    updated_at: o.updatedAt,
    deleted_at: o.deletedAt ?? null,
    ...owner(o),
  }),
  fromRow: (r) => ({
    id: String(r.id),
    workdayId: String(r.workday_id),
    status: r.status === 'done' ? 'done' : 'open',
    orderType: r.order_type as Order['orderType'],
    colisPlanned: num(r.colis_planned),
    linesCount: num(r.lines_count),
    colisActual: optNum(r.colis_actual),
    // Fusion avec le gabarit : un support ajouté dans une version ultérieure ne
    // doit pas revenir `undefined` sur une ligne enregistrée avant.
    supports: { ...EMPTY_SUPPORTS, ...((r.supports ?? {}) as Record<SupportKind, number>) },
    storeCount: num(r.store_count) === 2 ? 2 : 1,
    activePalletId: undef(r.active_pallet_id as string | null),
    startedAt: num(r.started_at),
    endedAt: optNum(r.ended_at),
    updatedAt: num(r.updated_at),
    deletedAt: optNum(r.deleted_at),
    ownerId: undef(r.user_id as string | null),
    syncState: 'synced',
  }),
}

const orderPallets: SyncTable<OrderPallet> = {
  remote: 'order_pallets',
  table: () => db.orderPallets,
  toRow: (p) => ({
    id: p.id,
    workday_id: p.workdayId,
    order_id: p.orderId,
    number: p.number,
    store_number: p.storeNumber,
    support: p.support ?? null,
    started_at: p.startedAt,
    ended_at: p.endedAt ?? null,
    start_count: p.startCount,
    end_count: p.endCount ?? null,
    updated_at: p.updatedAt,
    deleted_at: p.deletedAt ?? null,
    ...owner(p),
  }),
  fromRow: (r) => ({
    id: String(r.id), workdayId: String(r.workday_id), orderId: String(r.order_id),
    number: num(r.number), storeNumber: num(r.store_number) === 2 ? 2 : 1,
    support: undef(r.support as SupportKind | null),
    startedAt: num(r.started_at), endedAt: optNum(r.ended_at),
    startCount: num(r.start_count), endCount: optNum(r.end_count),
    updatedAt: num(r.updated_at), deletedAt: optNum(r.deleted_at),
    ownerId: undef(r.user_id as string | null), syncState: 'synced',
  }),
}

const segments: SyncTable<Segment> = {
  remote: 'segments',
  table: () => db.segments,
  toRow: (s) => ({
    id: s.id,
    workday_id: s.workdayId,
    order_id: s.orderId ?? null,
    pallet_id: s.palletId ?? null,
    type: s.type,
    started_at: s.startedAt,
    ended_at: s.endedAt ?? null,
    stack: s.stack ?? null,
    edited_at: s.editedAt ?? null,
    note: s.note ?? null,
    updated_at: s.updatedAt,
    deleted_at: s.deletedAt ?? null,
    ...owner(s),
  }),
  fromRow: (r) => ({
    id: String(r.id),
    workdayId: String(r.workday_id),
    orderId: undef(r.order_id as string | null),
    palletId: undef(r.pallet_id as string | null),
    type: r.type as Segment['type'],
    startedAt: num(r.started_at),
    // Reste `undefined` si la colonne est nulle : c'est ce qui distingue un
    // segment en cours d'un segment terminé.
    endedAt: optNum(r.ended_at),
    stack: undef(r.stack as Segment['stack']),
    editedAt: optNum(r.edited_at),
    note: undef(r.note as string | null),
    updatedAt: num(r.updated_at),
    deletedAt: optNum(r.deleted_at),
    ownerId: undef(r.user_id as string | null),
    syncState: 'synced',
  }),
}

const colisEvents: SyncTable<ColisEvent> = {
  remote: 'colis_events',
  table: () => db.colisEvents,
  toRow: (e) => ({
    id: e.id,
    workday_id: e.workdayId,
    order_id: e.orderId,
    pallet_id: e.palletId ?? null,
    at: e.at,
    delta: e.delta,
    updated_at: e.updatedAt,
    deleted_at: e.deletedAt ?? null,
    ...owner(e),
  }),
  fromRow: (r) => ({
    id: String(r.id),
    workdayId: String(r.workday_id),
    orderId: String(r.order_id),
    palletId: undef(r.pallet_id as string | null),
    at: num(r.at),
    delta: num(r.delta),
    updatedAt: num(r.updated_at),
    deletedAt: optNum(r.deleted_at),
    ownerId: undef(r.user_id as string | null),
    syncState: 'synced',
  }),
}

const stockShortages: SyncTable<StockShortage> = {
  remote: 'stock_shortages',
  table: () => db.stockShortages,
  toRow: (shortage) => ({
    id: shortage.id,
    workday_id: shortage.workdayId,
    order_id: shortage.orderId,
    at: shortage.at,
    quantity: shortage.quantity,
    resolved: shortage.resolved,
    updated_at: shortage.updatedAt,
    deleted_at: shortage.deletedAt ?? null,
    ...owner(shortage),
  }),
  fromRow: (row) => ({
    id: String(row.id),
    workdayId: String(row.workday_id),
    orderId: String(row.order_id),
    at: num(row.at),
    quantity: num(row.quantity),
    resolved: row.resolved === true,
    updatedAt: num(row.updated_at),
    deletedAt: optNum(row.deleted_at),
    ownerId: undef(row.user_id as string | null),
    syncState: 'synced',
  }),
}

/** Ordre d'envoi : les journées avant ce qu'elles contiennent. */
export const SYNC_TABLES: AnySyncTable[] = [
  define(workdays),
  define(orders),
  define(orderPallets),
  define(segments),
  define(colisEvents),
  define(stockShortages),
]
