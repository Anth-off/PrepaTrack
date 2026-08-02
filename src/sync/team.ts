import { getMeta, setMeta } from '../db/db'
import { getClient } from './client'
import type { Role } from './profile'

/**
 * Gestion de l'équipe, réservée aux gestionnaires.
 *
 * Aucun contrôle de rôle n'est fait ici : masquer un bouton n'a jamais protégé
 * une donnée. C'est la sécurité au niveau ligne, côté base, qui refuse les
 * écritures d'un préparateur — ces fonctions échoueraient simplement s'il les
 * appelait depuis la console.
 */

export interface Preparer {
  id: string
  badge: string
  name: string
  role: Role
  active: boolean
  /** Absent tant que le préparateur n'a pas défini son code. */
  userId?: string
}

function mapRow(row: Record<string, unknown>): Preparer {
  return {
    id: String(row.id),
    badge: String(row.badge),
    name: String(row.name),
    role: row.role === 'manager' ? 'manager' : 'preparer',
    active: row.active !== false,
    userId: row.user_id ? String(row.user_id) : undefined,
  }
}

const CACHE_KEY = 'team'

/**
 * Liste de l'équipe, avec repli sur la dernière connue.
 *
 * La liste vient du serveur, mais un gestionnaire consulte aussi ses écrans sans
 * réseau. Sans cache, toute la vue d'équipe afficherait « Compte inconnu » à la
 * place des noms dès que la connexion manque.
 */
export async function listPreparers(): Promise<Preparer[]> {
  const client = await getClient()
  if (!client) return getMeta<Preparer[]>(CACHE_KEY, [])

  const { data, error } = await client
    .from('preparers')
    .select('id, badge, name, role, active, user_id')
    .order('name')

  if (error) {
    const cached = await getMeta<Preparer[]>(CACHE_KEY, [])
    if (cached.length > 0) return cached
    throw new Error(error.message)
  }

  const team = (data ?? []).map((row) => mapRow(row as Record<string, unknown>))
  await setMeta(CACHE_KEY, team)
  return team
}

export async function addPreparer(
  badge: string,
  name: string,
  role: Role = 'preparer',
): Promise<string | undefined> {
  const client = await getClient()
  if (!client) return 'Synchro non configurée'
  const { error } = await client
    .from('preparers')
    .insert({ badge: badge.trim(), name: name.trim(), role })
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) return 'Ce badge existe déjà.'
    if (/row-level security/i.test(error.message)) return 'Réservé aux gestionnaires.'
    return error.message
  }
  return undefined
}

export async function updatePreparer(
  id: string,
  patch: Partial<Pick<Preparer, 'name' | 'role' | 'active'>>,
): Promise<string | undefined> {
  const client = await getClient()
  if (!client) return 'Synchro non configurée'
  const { error } = await client.from('preparers').update(patch).eq('id', id)
  return error?.message
}

/** Redéfinit le code d'un préparateur qui l'a oublié. */
export async function resetPin(preparerId: string, newPin: string): Promise<string | undefined> {
  const client = await getClient()
  if (!client) return 'Synchro non configurée'
  const { error } = await client.rpc('reset_preparer_pin', {
    p_preparer_id: preparerId,
    p_new_pin: newPin,
  })
  if (error) {
    if (/pas encore de compte/i.test(error.message)) {
      return "Ce préparateur n'a pas encore défini de code : il le fera à sa première connexion."
    }
    return error.message
  }
  return undefined
}
