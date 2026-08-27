import { db, getSettings } from './db'
import { scheduleDurableBackup } from '../native/durableStorage'
import type {
  ColisEvent,
  Order,
  OrderPallet,
  Segment,
  Settings,
  StockShortage,
  Workday,
  CoachingAlert,
} from '../core/types'

/**
 * Sauvegarde et restauration complètes, en un seul fichier.
 *
 * Indépendante de la synchro et du réseau : c'est le filet de sécurité quand on
 * change de téléphone, qu'on veut archiver une saison, ou simplement avant une
 * manipulation qui touche à l'hébergement. Les données d'une vacation ne se
 * ressaisissent pas de mémoire.
 */

export const BACKUP_FORMAT = 'prepatrack-backup'
export const BACKUP_VERSION = 4

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: number
  counts: Record<string, number>
  workdays: Workday[]
  orders: Order[]
  /** Facultatif pour accepter les sauvegardes créées avant le suivi par palette. */
  orderPallets?: OrderPallet[]
  segments: Segment[]
  colisEvents: ColisEvent[]
  /** Facultatif à la lecture pour rester compatible avec les sauvegardes v1. */
  stockShortages?: StockShortage[]
  /** Facultatif pour les sauvegardes antérieures au coach hors ligne. */
  coachingAlerts?: CoachingAlert[]
  settings: Settings
}

export async function buildBackup(): Promise<Backup> {
  const [workdays, orders, orderPallets, segments, colisEvents, stockShortages, coachingAlerts, settings] = await Promise.all([
    db.workdays.toArray(),
    db.orders.toArray(),
    db.orderPallets.toArray(),
    db.segments.toArray(),
    db.colisEvents.toArray(),
    db.stockShortages.toArray(),
    db.coachingAlerts.toArray(),
    getSettings(),
  ])

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    // Redondant avec les tableaux, mais permet de vérifier d'un coup d'œil
    // qu'un fichier contient bien quelque chose avant de le restaurer.
    counts: {
      workdays: workdays.length,
      orders: orders.length,
      orderPallets: orderPallets.length,
      segments: segments.length,
      colisEvents: colisEvents.length,
      stockShortages: stockShortages.length,
      coachingAlerts: coachingAlerts.length,
    },
    workdays,
    orders,
    orderPallets,
    segments,
    colisEvents,
    stockShortages,
    coachingAlerts,
    settings,
  }
}

export function backupFilename(at = Date.now()): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `prepatrack-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`
}

/**
 * Propose le fichier à l'utilisateur. Sur iPhone, un simple lien de
 * téléchargement finit souvent dans un onglet illisible : la feuille de partage
 * native permet au contraire d'enregistrer dans Fichiers, d'envoyer sur iCloud
 * ou de se l'expédier par mail. On l'utilise dès qu'elle est disponible.
 */
export async function downloadBackup(): Promise<'shared' | 'downloaded'> {
  const backup = await buildBackup()
  const json = JSON.stringify(backup, null, 2)
  const name = backupFilename(backup.exportedAt)
  const file = new File([json], name, { type: 'application/json' })

  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Sauvegarde PrepaTrack' })
      return 'shared'
    } catch (error) {
      // L'utilisateur a pu simplement fermer la feuille de partage : on ne
      // retombe sur le téléchargement que si le partage est vraiment indisponible.
      if (error instanceof DOMException && error.name === 'AbortError') throw error
    }
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}

export interface RestoreResult {
  added: number
  updated: number
  skipped: number
}

function isBackup(value: unknown): value is Backup {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Backup>
  return (
    candidate.format === BACKUP_FORMAT &&
    Array.isArray(candidate.workdays) &&
    Array.isArray(candidate.orders) &&
    Array.isArray(candidate.segments) &&
    Array.isArray(candidate.colisEvents)
  )
}

/**
 * Restaure une sauvegarde par fusion, jamais par remplacement : une ligne
 * locale plus récente que celle du fichier est conservée. Restaurer une vieille
 * sauvegarde ne peut donc pas effacer le travail des jours suivants.
 *
 * Tout ce qui est écrit repasse en `pending` pour repartir vers Supabase à la
 * prochaine synchro.
 */
export async function restoreBackup(json: string): Promise<RestoreResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error("Ce fichier n'est pas lisible.")
  }
  if (!isBackup(parsed)) {
    throw new Error("Ce fichier n'est pas une sauvegarde PrepaTrack.")
  }

  const result: RestoreResult = { added: 0, updated: 0, skipped: 0 }

  await db.transaction(
    'rw',
    [db.workdays, db.orders, db.orderPallets, db.segments, db.colisEvents, db.stockShortages, db.coachingAlerts, db.settings],
    async () => {
      await merge(db.workdays, parsed.workdays, result)
      await merge(db.orders, parsed.orders, result)
      await merge(db.orderPallets, parsed.orderPallets ?? [], result)
      await merge(db.segments, parsed.segments, result)
      await merge(db.colisEvents, parsed.colisEvents, result)
      await merge(db.stockShortages, parsed.stockShortages ?? [], result)
      await merge(db.coachingAlerts, parsed.coachingAlerts ?? [], result)
      await restoreSettings(parsed.settings)
    },
  )

  // Les écritures de fusion contournent volontairement `stamp`. Il faut donc
  // demander explicitement une nouvelle photographie native après un import.
  scheduleDurableBackup()

  return result
}

async function restoreSettings(settings: unknown): Promise<void> {
  if (!settings || typeof settings !== 'object') return
  const candidate = settings as Partial<Settings>
  if (candidate.id !== 'settings' || !Number.isFinite(candidate.updatedAt)) return
  const current = await db.settings.get('settings')
  if (current && current.updatedAt >= candidate.updatedAt!) return
  await db.settings.put(candidate as Settings)
}

async function merge<T extends { id: string; updatedAt: number; syncState: string }>(
  table: { bulkGet: (ids: string[]) => Promise<(T | undefined)[]>; bulkPut: (rows: T[]) => Promise<unknown> },
  rows: T[],
  result: RestoreResult,
): Promise<void> {
  if (rows.length === 0) return
  const existing = await table.bulkGet(rows.map((r) => r.id))
  const toWrite: T[] = []

  rows.forEach((row, i) => {
    const current = existing[i]
    if (current && current.updatedAt >= row.updatedAt) {
      result.skipped += 1
      return
    }
    if (current) result.updated += 1
    else result.added += 1
    toWrite.push({ ...row, syncState: 'pending' })
  })

  if (toWrite.length > 0) await table.bulkPut(toWrite)
}
