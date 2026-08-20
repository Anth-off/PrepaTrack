import { getMeta, setMeta } from '../db/db'

/**
 * Identité du compte connecté sur cet appareil.
 *
 * Conservée en local et en mémoire pour deux raisons : les écrans doivent
 * connaître le rôle sans attendre le réseau, et le repository a besoin du
 * propriétaire à chaque écriture — y compris en pleine vacation, hors ligne,
 * des heures après la dernière connexion.
 */

export type Role = 'preparer' | 'manager'

export interface Profile {
  /** Identifiant du compte Supabase, propriétaire des lignes créées. */
  userId: string
  preparerId: string
  badge: string
  name: string
  role: Role
}

const META_KEY = 'profile'

let cached: Profile | undefined
let loaded = false
/**
 * Comptes du projet Supabase actuel (soi + l'équipe connue). Un UUID qui n'y
 * figure pas vient d'un ancien projet : l'envoyer ferait échouer la clé
 * étrangère vers `auth.users`.
 */
let knownOwnerIds = new Set<string>()

export async function loadProfile(): Promise<Profile | undefined> {
  if (!loaded) {
    cached = await getMeta<Profile | undefined>(META_KEY, undefined)
    loaded = true
  }
  return cached
}

export async function saveProfile(profile: Profile | undefined): Promise<void> {
  cached = profile
  loaded = true
  await setMeta(META_KEY, profile)
  knownOwnerIds = profile ? new Set([profile.userId]) : new Set()
}

/**
 * Version synchrone, pour les chemins qui ne peuvent pas attendre — notamment
 * la création d'un segment, appelée à chaque appui sur un bouton. Renvoie
 * `undefined` tant que `loadProfile()` n'a pas été appelé au moins une fois, ce
 * que fait le démarrage de l'application.
 */
export function currentProfile(): Profile | undefined {
  return cached
}

export function currentOwnerId(): string | undefined {
  return cached?.userId
}

export function rememberKnownOwnerIds(ids: Iterable<string>): void {
  knownOwnerIds = new Set(ids)
  const me = currentOwnerId()
  if (me) knownOwnerIds.add(me)
}

export function forgetKnownOwnerIds(): void {
  knownOwnerIds = new Set()
}

/** Ce propriétaire existe-t-il sur le projet Supabase auquel on est connecté ? */
export function isKnownOwnerId(id: string): boolean {
  return id === currentOwnerId() || knownOwnerIds.has(id)
}

export function isManager(): boolean {
  return cached?.role === 'manager'
}

/**
 * Une ligne appartient-elle au compte courant ?
 *
 * Les lignes sans propriétaire sont considérées comme siennes : ce sont celles
 * créées avant toute connexion, quand l'application servait en solo. Les
 * abandonner ferait disparaître l'historique déjà enregistré.
 */
export function ownedByCurrent(row: { ownerId?: string }): boolean {
  const me = currentOwnerId()
  if (!me) return true
  return row.ownerId === undefined || row.ownerId === me
}
