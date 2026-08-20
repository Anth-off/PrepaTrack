import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { badgeToEmail, PIN_LENGTH, validateBadge, validatePin } from './auth'
import { adoptStaleOwners, claimOrphans, listWorkdays, listWorkdaysOf, startDay } from '../db/repo'
import { currentOwnerId, isManager, loadProfile, ownedByCurrent, saveProfile } from './profile'

const T = new Date(2026, 7, 3, 13, 0, 0).getTime()

beforeEach(async () => {
  await db.delete()
  await db.open()
  await saveProfile(undefined)
})

describe('identifiants de connexion', () => {
  it('refuse un badge qui n’en est pas un', () => {
    expect(validateBadge('1234567')).toBeUndefined()
    expect(validateBadge('123')).toBeDefined()
    expect(validateBadge('65a4109')).toBeDefined()
    expect(validateBadge('')).toBeDefined()
  })

  it('impose un code de la bonne longueur', () => {
    expect(validatePin('123456')).toBeUndefined()
    expect(validatePin('12345')).toBeDefined()
    expect(validatePin('1234567')).toBeDefined()
    // Un code non numérique passerait sur un pavé physique mais pas ici.
    expect(validatePin('12345a')).toBeDefined()
    expect(PIN_LENGTH).toBe(6)
  })

  it('fabrique une adresse technique à partir du badge', () => {
    expect(badgeToEmail('1234567')).toBe('1234567@prepatrack.local')
    expect(badgeToEmail(' 1234567 ')).toBe('1234567@prepatrack.local')
  })
})

describe('cloisonnement des données', () => {
  it('considère comme siennes les lignes créées avant toute connexion', async () => {
    expect(currentOwnerId()).toBeUndefined()
    expect(ownedByCurrent({ ownerId: undefined })).toBe(true)
    // Sans compte, tout est à soi : l'app doit rester utilisable seule.
    expect(ownedByCurrent({ ownerId: 'quelqu-un' })).toBe(true)
  })

  it('écarte les lignes d’un autre compte une fois connecté', async () => {
    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1234567',
      name: 'Moi',
      role: 'preparer',
    })
    expect(ownedByCurrent({ ownerId: 'moi' })).toBe(true)
    expect(ownedByCurrent({ ownerId: 'un-collegue' })).toBe(false)
    // Les lignes d'avant la connexion restent rattachées à soi.
    expect(ownedByCurrent({ ownerId: undefined })).toBe(true)
  })

  it('estampille les nouvelles vacations au compte courant', async () => {
    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1234567',
      name: 'Moi',
      role: 'preparer',
    })
    await startDay(T)
    const [workday] = await db.workdays.toArray()
    expect(workday.ownerId).toBe('moi')
  })

  it('n’affiche que ses propres vacations dans l’historique', async () => {
    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1234567',
      name: 'Moi',
      role: 'manager',
    })
    await startDay(T)

    // Vacation reçue d'un collègue via la synchro : un gestionnaire les reçoit
    // toutes, mais son propre suivi ne doit pas les compter.
    await db.workdays.put({
      id: 'autre',
      date: '2026-08-03',
      status: 'closed',
      startedAt: T,
      endedAt: T + 3600_000,
      updatedAt: T,
      syncState: 'synced',
      ownerId: 'un-collegue',
    })

    const mine = await listWorkdays()
    expect(mine).toHaveLength(1)
    expect(mine[0].ownerId).toBe('moi')
    expect(await db.workdays.count()).toBe(2)
  })

  it('ne reprend pas la vacation ouverte d’un collègue', async () => {
    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1234567',
      name: 'Moi',
      role: 'manager',
    })
    // Journée d'un collègue, restée ouverte, descendue par la synchro.
    await db.workdays.put({
      id: 'autre',
      date: '2026-08-03',
      status: 'open',
      startedAt: T,
      updatedAt: T,
      syncState: 'synced',
      ownerId: 'un-collegue',
    })

    const { loadSnapshot } = await import('../db/repo')
    const snap = await loadSnapshot()
    // Sans filtre sur le propriétaire, le gestionnaire « reprendrait » la
    // vacation du collègue en ouvrant l'application.
    expect(snap.workday).toBeUndefined()
  })
})

describe('rattachement des vacations d’avant la connexion', () => {
  it('rend les journées orphelines visibles depuis la fiche du préparateur', async () => {
    // Vacation enregistrée avant que le multi-utilisateurs n'existe.
    await startDay(T)
    expect((await db.workdays.toArray())[0].ownerId).toBeUndefined()

    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1234567',
      name: 'Anthony',
      role: 'manager',
    })

    // Avant rattachement : le suivi personnel les tolère, mais la recherche par
    // compte ne les trouve pas — c'est ce décalage qui affichait « aucune
    // donnée reçue » sur sa propre fiche.
    expect(await listWorkdays()).toHaveLength(1)
    expect(await listWorkdaysOf('moi')).toHaveLength(0)

    const claimed = await claimOrphans('moi')
    expect(claimed).toBeGreaterThan(0)

    expect(await listWorkdaysOf('moi')).toHaveLength(1)
    expect(await listWorkdays()).toHaveLength(1)
  })

  it('marque les lignes rattachées pour qu’elles repartent au serveur', async () => {
    await startDay(T)
    await db.workdays.toCollection().modify({ syncState: 'synced' })

    await claimOrphans('moi')
    const workday = (await db.workdays.toArray())[0]
    expect(workday.ownerId).toBe('moi')
    expect(workday.syncState).toBe('pending')
  })

  it('ne touche pas aux vacations d’un collègue', async () => {
    await db.workdays.put({
      id: 'autre',
      date: '2026-08-03',
      status: 'closed',
      startedAt: T,
      endedAt: T + 1000,
      updatedAt: T,
      syncState: 'synced',
      ownerId: 'un-collegue',
    })

    await claimOrphans('moi')
    const workday = await db.workdays.get('autre')
    // S'approprier la production de l'équipe en se connectant serait le pire
    // effet de bord possible pour un gestionnaire.
    expect(workday?.ownerId).toBe('un-collegue')
    expect(workday?.syncState).toBe('synced')
  })

  it('rattache les lignes d’un ancien projet au compte courant', async () => {
    await db.workdays.put({
      id: 'ancien',
      date: '2026-08-03',
      status: 'closed',
      startedAt: T,
      endedAt: T + 1000,
      updatedAt: T,
      syncState: 'synced',
      ownerId: 'uuid-ancien-projet',
    })
    await db.workdays.put({
      id: 'collegue',
      date: '2026-08-03',
      status: 'closed',
      startedAt: T,
      endedAt: T + 1000,
      updatedAt: T,
      syncState: 'synced',
      ownerId: 'un-collegue',
    })

    const adopted = await adoptStaleOwners('moi', new Set(['moi', 'un-collegue']))
    expect(adopted).toBe(1)
    expect(await db.workdays.get('ancien')).toMatchObject({
      ownerId: 'moi',
      syncState: 'pending',
    })
    expect(await db.workdays.get('collegue')).toMatchObject({
      ownerId: 'un-collegue',
      syncState: 'synced',
    })
  })
})

describe('rôle', () => {
  it('ne reconnaît gestionnaire que le rôle explicite', async () => {
    expect(isManager()).toBe(false)
    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1',
      name: 'A',
      role: 'preparer',
    })
    expect(isManager()).toBe(false)
    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1',
      name: 'A',
      role: 'manager',
    })
    expect(isManager()).toBe(true)
  })

  it('relit le profil depuis le stockage local au démarrage', async () => {
    await saveProfile({
      userId: 'moi',
      preparerId: 'p1',
      badge: '1234567',
      name: 'Moi',
      role: 'manager',
    })
    // Simule un redémarrage : le cache mémoire est vidé, pas la base.
    const reloaded = await loadProfile()
    expect(reloaded?.role).toBe('manager')
  })
})
