import { getMeta, setMeta } from '../db/db'
import { forgetKnownOwnerIds } from './profile'

export interface SyncConfig {
  url: string
  anonKey: string
}

const META_KEY = 'supabase'

/**
 * Les identifiants Supabase peuvent venir de deux endroits : les variables
 * d'environnement du build, ou une saisie dans l'app.
 *
 * La saisie dans l'app est là pour une raison pratique : elle évite d'avoir à
 * configurer des variables d'environnement sur Vercel puis à reconstruire à
 * chaque changement. La clé « anon » est de toute façon publique par
 * conception — c'est la sécurité au niveau ligne (RLS) qui protège les données,
 * pas le secret de cette clé.
 */
export async function loadSyncConfig(): Promise<SyncConfig | undefined> {
  const stored = await getMeta<SyncConfig | undefined>(META_KEY, undefined)
  if (stored?.url && stored?.anonKey) return stored

  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (url && anonKey) return { url, anonKey }

  return undefined
}

export async function saveSyncConfig(config: SyncConfig): Promise<void> {
  const previous = await loadSyncConfig()
  const next = {
    url: config.url.trim().replace(/\/+$/, ''),
    anonKey: config.anonKey.trim(),
  }
  await setMeta(META_KEY, next)
  if (previous?.url && previous.url !== next.url) {
    await setMeta('team', undefined)
    forgetKnownOwnerIds()
  }
}

export async function clearSyncConfig(): Promise<void> {
  await setMeta(META_KEY, undefined)
  await setMeta('team', undefined)
  forgetKnownOwnerIds()
}

/** Contrôle de forme, pour attraper un copier-coller de travers tout de suite. */
export function validateConfig(config: SyncConfig): string | undefined {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(config.url.trim())) {
    return "L'adresse doit ressembler à https://xxxxx.supabase.co"
  }
  if (config.anonKey.trim().length < 40) {
    return 'La clé publique semble incomplète'
  }
  return undefined
}
