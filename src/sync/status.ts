import type { SyncOutcome } from './sync'

export type SyncDisplayState = 'local' | 'offline' | 'pending' | 'running' | 'up-to-date' | 'error'

export interface SyncStatusInput {
  configured: boolean
  connected: boolean
  online: boolean
  busy: boolean
  pending: number
  lastSuccessAt?: number
  outcome?: SyncOutcome
}

export interface SyncStatus {
  state: SyncDisplayState
  label: string
  detail: string
}

export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  if (!input.configured || !input.connected) {
    return { state: 'local', label: 'Local uniquement', detail: 'Les données sont enregistrées sur cet appareil.' }
  }
  if (!input.online || input.outcome?.state === 'offline') {
    return {
      state: 'offline',
      label: 'Hors ligne',
      detail: input.pending > 0
        ? `${input.pending} modification${input.pending > 1 ? 's' : ''} sera${input.pending > 1 ? 'ont' : ''} envoyée${input.pending > 1 ? 's' : ''} au retour du réseau.`
        : 'La synchronisation reprendra automatiquement au retour du réseau.',
    }
  }
  if (input.busy) {
    return { state: 'running', label: 'Synchronisation en cours', detail: 'Échange sécurisé en cours.' }
  }
  if (input.outcome?.state === 'error') {
    return {
      state: 'error',
      label: 'Synchronisation bloquée',
      detail: input.outcome.error ?? 'La synchronisation a échoué. Les données locales sont conservées.',
    }
  }
  if (input.pending > 0 || !input.lastSuccessAt) {
    return {
      state: 'pending',
      label: input.pending > 0 ? 'En attente' : 'Première synchronisation en attente',
      detail: input.pending > 0
        ? `${input.pending} modification${input.pending > 1 ? 's' : ''} à envoyer.`
        : 'Aucune réussite enregistrée pour le moment.',
    }
  }
  return { state: 'up-to-date', label: 'À jour', detail: 'Toutes les modifications sont synchronisées.' }
}
