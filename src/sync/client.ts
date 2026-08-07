import type { SupabaseClient } from '@supabase/supabase-js'
import { loadSyncConfig, type SyncConfig } from './config'
import { persistDurableAuthSession } from '../native/durableStorage'

let client: SupabaseClient | undefined
let clientKey = ''

/**
 * Client Supabase, créé à la demande et mémorisé. Renvoie `undefined` tant que
 * rien n'est configuré : toute l'application doit continuer à fonctionner sans
 * synchro, c'est le mode normal pendant la vacation.
 *
 * La bibliothèque est chargée en import dynamique — elle pèse à elle seule plus
 * que tout le reste de l'app. La sortir du bundle de démarrage évite de la payer
 * à chaque lancement alors qu'elle ne sert qu'une fois le réseau revenu. Le
 * service worker la précache quand même, la synchro reste donc disponible hors
 * ligne pour repartir dès la reconnexion.
 */
export async function getClient(): Promise<SupabaseClient | undefined> {
  const config = await loadSyncConfig()
  if (!config) return undefined
  return buildClient(config)
}

export async function buildClient(config: SyncConfig): Promise<SupabaseClient> {
  const key = `${config.url}|${config.anonKey}`
  if (client && clientKey === key) return client

  const { createClient } = await import('@supabase/supabase-js')
  client = createClient(config.url, config.anonKey, {
    auth: {
      // La session doit survivre à la fermeture de l'app et se renouveler seule :
      // hors de question de redemander une connexion en pleine vacation.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'prepatrack-auth',
    },
  })
  // Supabase peut renouveler son jeton à n'importe quel moment. Le miroir
  // Keychain est mis à jour dès l'événement, sans attendre la sauvegarde
  // périodique, afin qu'une extinction juste après le renouvellement ne rende
  // pas l'ancienne session inutilisable.
  client.auth.onAuthStateChange((_event, session) => {
    if (session) window.setTimeout(() => { void persistDurableAuthSession() }, 0)
  })
  clientKey = key
  return client
}

export function resetClient(): void {
  client = undefined
  clientKey = ''
}
