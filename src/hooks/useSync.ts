import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { countPending, getLastSyncAt, runSync, type SyncOutcome } from '../sync/sync'
import { getCurrentProfile } from '../sync/auth'
import { loadProfile, type Profile } from '../sync/profile'
import { loadSyncConfig } from '../sync/config'
import { claimOrphans } from '../db/repo'

const AUTO_INTERVAL = 5 * 60_000

export interface SyncInfo {
  outcome?: SyncOutcome
  pending: number
  lastSyncAt?: number
  profile?: Profile
  configured: boolean
  busy: boolean
  sync: () => Promise<void>
  refreshUser: () => Promise<void>
}

/**
 * Pilote la synchronisation en tâche de fond.
 *
 * Les tentatives se déclenchent au retour du réseau, au retour au premier plan
 * et à intervalle régulier — jamais à un moment qui pourrait interrompre la
 * saisie. Un échec est sans conséquence : les lignes restent en attente et
 * repartiront au prochain passage.
 */
export function useSync(): SyncInfo {
  const [outcome, setOutcome] = useState<SyncOutcome | undefined>()
  const [profile, setProfile] = useState<Profile | undefined>()
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  /** Évite de reparcourir les tables à chaque rafraîchissement du profil. */
  const claimedFor = useRef<string | undefined>(undefined)

  const pending = useLiveQuery(() => countPending(), [], 0)
  const lastSyncAt = useLiveQuery(() => getLastSyncAt(), [outcome?.at])

  const refreshUser = useCallback(async () => {
    // Le profil est d'abord relu depuis le stockage local : le repository en a
    // besoin de façon synchrone dès la première écriture, y compris hors ligne.
    await loadProfile()
    const [current, config] = await Promise.all([getCurrentProfile(), loadSyncConfig()])
    if (!mounted.current) return

    // Rattrapage : un compte déjà connecté au moment où le multi-utilisateurs a
    // été mis en place n'est jamais repassé par l'écran de connexion, et ses
    // anciennes vacations seraient restées sans propriétaire.
    if (current && claimedFor.current !== current.userId) {
      claimedFor.current = current.userId
      await claimOrphans(current.userId)
    }

    setProfile(current)
    setConfigured(Boolean(config))
  }, [])

  const sync = useCallback(async () => {
    setBusy(true)
    try {
      const result = await runSync()
      if (mounted.current) setOutcome(result)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refreshUser()
    void sync()

    const onOnline = () => void sync()
    const onVisible = () => {
      if (!document.hidden) void sync()
    }
    const timer = window.setInterval(() => void sync(), AUTO_INTERVAL)

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      mounted.current = false
      window.clearInterval(timer)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshUser, sync])

  return {
    outcome,
    pending: pending ?? 0,
    lastSyncAt: lastSyncAt ?? undefined,
    profile,
    configured,
    busy,
    sync,
    refreshUser,
  }
}
