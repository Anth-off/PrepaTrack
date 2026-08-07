import { Capacitor, registerPlugin } from '@capacitor/core'

interface DurableStoragePlugin {
  save(options: { data: string }): Promise<DurableBackupStatus>
  load(): Promise<DurableBackupStatus & { data?: string | null }>
  status(): Promise<DurableBackupStatus>
  saveSession(options: { data: string }): Promise<void>
  loadSession(): Promise<{ data?: string | null }>
  clearSession(): Promise<void>
}

export interface DurableBackupStatus {
  available: boolean
  savedAt?: number
  bytes?: number
  source?: 'current' | 'previous'
  redundant?: boolean
}

interface NativeState {
  meta?: Array<{ key: string; value: unknown }>
}

const plugin = registerPlugin<DurableStoragePlugin>('DurableStorage')
const supported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

export async function recoverDurableBackup(): Promise<void> {
  if (!supported()) return
  try {
    const session = await plugin.loadSession()
    const localSession = window.localStorage.getItem('prepatrack-auth')
    const selectedSession = newestAuthSession(localSession, session.data ?? undefined)
    if (selectedSession && selectedSession !== localSession) {
      window.localStorage.setItem('prepatrack-auth', selectedSession)
    }
    const { data } = await plugin.load()
    if (!data) return
    const parsed = JSON.parse(data) as { nativeState?: NativeState }
    if (Array.isArray(parsed.nativeState?.meta)) {
      const { restoreMissingMeta } = await import('../db/db')
      await restoreMissingMeta(parsed.nativeState.meta)
    }
    const { restoreBackup } = await import('../db/backup')
    await restoreBackup(data)
  } catch {
    // IndexedDB reste la source principale. Une copie native illisible ne doit
    // jamais empêcher l'application de démarrer.
  }
}

/** Choisit la session Supabase la plus récente sans rétrograder le jeton local. */
export function newestAuthSession(
  local: string | null | undefined,
  durable: string | null | undefined,
): string | undefined {
  if (!local) return durable ?? undefined
  if (!durable) return local
  const localExpiry = authExpiry(local)
  const durableExpiry = authExpiry(durable)
  // À égalité ou si le format est inconnu, la copie actuellement utilisée par
  // Supabase reste prioritaire. Le Keychain est un filet, pas la source active.
  return durableExpiry > localExpiry ? durable : local
}

function authExpiry(value: string): number {
  try {
    const parsed = JSON.parse(value) as { expires_at?: unknown }
    return typeof parsed.expires_at === 'number' && Number.isFinite(parsed.expires_at)
      ? parsed.expires_at
      : Number.NEGATIVE_INFINITY
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
let pending = false
let inFlight: Promise<DurableBackupStatus | undefined> | undefined
let protectionStarted = false

export async function durableBackupStatus(): Promise<DurableBackupStatus> {
  if (!supported()) return { available: false }
  try {
    return await plugin.status()
  } catch {
    return { available: false }
  }
}

export const durableBackupSupported = supported

export async function clearDurableAuthSession(): Promise<void> {
  if (!supported()) return
  try { await plugin.clearSession() } catch { /* La déconnexion Supabase reste prioritaire. */ }
}

/** Recopie immédiatement la session courante après connexion ou renouvellement. */
export async function persistDurableAuthSession(): Promise<void> {
  if (!supported()) return
  const authSession = window.localStorage.getItem('prepatrack-auth')
  if (!authSession) return
  try { await plugin.saveSession({ data: authSession }) } catch { /* Le miroir périodique réessaiera. */ }
}

/** Écrit immédiatement une photographie complète et validée hors de la WebView. */
export async function flushDurableBackup(): Promise<DurableBackupStatus | undefined> {
  if (!supported()) return undefined
  pending = false
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  if (inFlight) {
    pending = true
    await inFlight
    return pending ? flushDurableBackup() : durableBackupStatus()
  }
  inFlight = (async () => {
    try {
      const { buildBackup } = await import('../db/backup')
      const { db } = await import('../db/db')
      const meta = (await db.meta.bulkGet(['supabase', 'profile'])).filter(
        (row): row is { key: string; value: unknown } => row !== undefined,
      )
      const payload = { ...(await buildBackup()), nativeState: { meta } }
      await persistDurableAuthSession()
      return await plugin.save({ data: JSON.stringify(payload) })
    } catch {
      return undefined
    }
  })()
  try {
    return await inFlight
  } finally {
    inFlight = undefined
    if (pending) void flushDurableBackup()
  }
}

/** Regroupe les écritures rapprochées et persiste une copie atomique hors WebView. */
export function scheduleDurableBackup(): void {
  if (!supported()) return
  pending = true
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    if (!pending) return
    void flushDurableBackup()
  }, 100)
}

/** Filet périodique et sauvegarde immédiate avant toute suspension de l'app. */
export function startDurableBackupProtection(): void {
  if (!supported() || protectionStarted) return
  protectionStarted = true
  window.setInterval(() => { void flushDurableBackup() }, 15_000)
  const flushWhenHidden = () => {
    if (document.visibilityState === 'hidden') void flushDurableBackup()
  }
  document.addEventListener('visibilitychange', flushWhenHidden)
  window.addEventListener('pagehide', () => { void flushDurableBackup() })
}
