import { claimOrphans } from '../db/repo'
import { getClient, resetClient } from './client'
import { loadProfile, saveProfile, type Profile, type Role } from './profile'
import { resetCursors } from './sync'
import { clearDurableAuthSession } from '../native/durableStorage'

/**
 * Connexion par numéro de badge et code personnel.
 *
 * Supabase authentifie par adresse e-mail ; un préparateur, lui, s'identifie
 * par le numéro inscrit sur son badge. On fabrique donc une adresse technique à
 * partir du badge. Le domaine `prepatrack.local` n'existe pas et ne reçoit
 * jamais rien : aucun message n'est envoyé, c'est le code personnel qui fait
 * office de mot de passe.
 *
 * Le badge seul ne suffit jamais à entrer : il se lit par-dessus une épaule, et
 * ces chiffres peuvent finir en entretien annuel.
 */

/** Domaine technique, jamais utilisé pour envoyer quoi que ce soit. */
const BADGE_DOMAIN = 'prepatrack.local'

/** Supabase impose six caractères minimum ; on s'y aligne. */
export const PIN_LENGTH = 6

export function badgeToEmail(badge: string): string {
  return `${badge.trim()}@${BADGE_DOMAIN}`
}

export function validateBadge(badge: string): string | undefined {
  if (!/^\d{4,12}$/.test(badge.trim())) {
    return 'Le numéro de badge doit comporter entre 4 et 12 chiffres.'
  }
  return undefined
}

export function validatePin(pin: string): string | undefined {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    return `Le code personnel doit comporter ${PIN_LENGTH} chiffres.`
  }
  return undefined
}

export async function getCurrentProfile(): Promise<Profile | undefined> {
  const client = await getClient()
  if (!client) return loadProfile()

  const { data } = await client.auth.getSession()
  const user = data.session?.user
  if (!user) return undefined

  // Le profil local suffit hors ligne ; on ne redemande la fiche au serveur que
  // si elle manque ou si le compte a changé.
  const local = await loadProfile()
  if (local && local.userId === user.id) return local

  return fetchProfile(user.id)
}

async function fetchProfile(userId: string): Promise<Profile | undefined> {
  const client = await getClient()
  if (!client) return undefined

  const { data, error } = await client
    .from('preparers')
    .select('id, badge, name, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !data) return undefined

  const profile: Profile = {
    userId,
    preparerId: String(data.id),
    badge: String(data.badge),
    name: String(data.name),
    role: (data.role === 'manager' ? 'manager' : 'preparer') as Role,
  }
  await saveProfile(profile)
  return profile
}

export async function signIn(badge: string, pin: string): Promise<string | undefined> {
  const client = await getClient()
  if (!client) return 'Synchro non configurée'

  const { data, error } = await client.auth.signInWithPassword({
    email: badgeToEmail(badge),
    password: pin,
  })

  if (error) {
    if (/invalid login credentials/i.test(error.message)) {
      return 'Badge ou code incorrect. Première connexion ? Utilise « Définir mon code ».'
    }
    return error.message
  }

  const profile = await fetchProfile(data.user!.id)
  if (!profile) {
    await client.auth.signOut()
    return "Ce compte n'est rattaché à aucun préparateur. Préviens ton gestionnaire."
  }

  // Les vacations enregistrées avant la première connexion deviennent celles de
  // ce compte, et repartent vers le serveur sous son nom.
  await claimOrphans(profile.userId)
  await resetCursors()
  return undefined
}

/**
 * Première connexion : crée le compte rattaché à un badge déjà déclaré.
 *
 * Le contrôle est fait côté base par un déclencheur — un badge inconnu ou déjà
 * utilisé fait échouer la création. Impossible donc de s'inscrire librement, ni
 * de prendre le badge d'un collègue.
 */
export async function createAccount(badge: string, pin: string): Promise<string | undefined> {
  const client = await getClient()
  if (!client) return 'Synchro non configurée'

  const { data, error } = await client.auth.signUp({
    email: badgeToEmail(badge),
    password: pin,
  })

  if (error) {
    if (/badge inconnu|désactivé/i.test(error.message)) {
      return "Ce badge n'est pas déclaré. Demande à ton gestionnaire de l'ajouter."
    }
    if (/déjà un compte|already registered|already exists/i.test(error.message)) {
      return 'Ce badge a déjà un code. Utilise « Se connecter ».'
    }
    if (/email address.*invalid|invalid format/i.test(error.message)) {
      return "Supabase refuse le format d'adresse technique. Désactive « Confirm email » dans les réglages d'authentification du projet."
    }
    return error.message
  }

  // Sans session ouverte, Supabase attend une confirmation par e-mail — or
  // l'adresse est fictive et ne recevra jamais rien.
  if (!data.session) {
    return "Désactive « Confirm email » dans les réglages d'authentification Supabase : l'adresse est technique et ne reçoit aucun message."
  }

  const profile = await fetchProfile(data.user!.id)
  if (!profile) return 'Compte créé mais non rattaché. Préviens ton gestionnaire.'

  await claimOrphans(profile.userId)
  await resetCursors()
  return undefined
}

export async function signOut(): Promise<void> {
  const client = await getClient()
  await client?.auth.signOut()
  await saveProfile(undefined)
  // Les données locales restent intactes : se déconnecter ne doit jamais faire
  // perdre une vacation en cours.
  await resetCursors()
  resetClient()
  await clearDurableAuthSession()
}
