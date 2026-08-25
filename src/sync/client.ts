import type { SupabaseClient } from '@supabase/supabase-js'
import { loadSyncConfig, type SyncConfig } from './config'
import {
  authSessionTokens,
  loadDurableAuthSession,
  persistDurableAuthSession,
} from '../native/durableStorage'

let client: SupabaseClient | undefined
let clientKey = ''
let authSubscription: { unsubscribe: () => void } | undefined
let clientGeneration = 0
let authRecovery: Promise<boolean> | undefined

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
  releaseClient()

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
  const generation = ++clientGeneration
  // Supabase peut renouveler son jeton à n'importe quel moment. Le miroir
  // Keychain est mis à jour dès l'événement, sans attendre la sauvegarde
  // périodique, afin qu'une extinction juste après le renouvellement ne rende
  // pas l'ancienne session inutilisable.
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => {
      if (generation !== clientGeneration) return
      // INITIAL_SESSION peut être vide si la WebView vient d'être recréée et
      // SIGNED_OUT peut être émis après un échec réseau pendant un refresh.
      // Aucun de ces événements ne doit détruire notre dernier jeton sain : la
      // copie Keychain n'est effacée que par l'action explicite « Se déconnecter ».
      if (session) void persistDurableAuthSession(JSON.stringify(session))
    }, 0)
  })
  authSubscription = data.subscription
  clientKey = key
  return client
}

/**
 * Restaure silencieusement une session perdue par la WebView depuis le Keychain.
 * En mode avion, l'échec est sans effet : la même copie sera retentée au retour
 * du réseau au lieu de renvoyer l'utilisateur vers l'écran badge/code.
 */
export async function recoverClientAuth(target: SupabaseClient): Promise<boolean> {
  const current = await target.auth.getSession()
  if (current.data.session) return true
  if (authRecovery) return authRecovery

  authRecovery = (async () => {
    const tokens = authSessionTokens(await loadDurableAuthSession())
    if (!tokens) return false
    try {
      const { data, error } = await target.auth.setSession(tokens)
      if (error || !data.session) return false
      await persistDurableAuthSession(JSON.stringify(data.session))
      return true
    } catch {
      return false
    }
  })()
  try {
    return await authRecovery
  } finally {
    authRecovery = undefined
  }
}

export function resetClient(): void {
  releaseClient()
}

function releaseClient(): void {
  clientGeneration += 1
  authSubscription?.unsubscribe()
  authSubscription = undefined
  client?.auth.stopAutoRefresh()
  client = undefined
  clientKey = ''
  authRecovery = undefined
}
