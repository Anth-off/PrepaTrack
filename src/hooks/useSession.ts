import { useLiveQuery } from 'dexie-react-hooks'
import { deriveView, type MachineView, type Snapshot } from '../core/machine'
import { computeDayMetrics, computeLive, type DayMetrics, type LiveStatus } from '../core/metrics'
import { registerCustomIncidents } from '../core/segments'
import type { ColisEvent, Settings, StockShortage } from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'
import { getSettings } from '../db/db'
import { colisEventsFor, loadSnapshot, stockShortagesFor } from '../db/repo'
import { useNow } from './useNow'

export interface Session {
  snap: Snapshot
  view: MachineView
  events: ColisEvent[]
  shortages: StockShortage[]
  settings: Settings
  day: DayMetrics
  live?: LiveStatus
  now: number
  loading: boolean
}

const EMPTY_SNAP: Snapshot = { segments: [], orders: [] }

/**
 * État complet de la vacation en cours. `useLiveQuery` observe les tables
 * Dexie : toute écriture rafraîchit l'interface sans qu'aucun écran n'ait à
 * gérer d'invalidation.
 */
export function useSession(): Session {
  const now = useNow(1000)

  const data = useLiveQuery(async () => {
    const snap = await loadSnapshot()
    const [events, shortages, settings] = await Promise.all([
      snap.workday ? colisEventsFor(snap.workday.id) : Promise.resolve([]),
      snap.workday ? stockShortagesFor(snap.workday.id) : Promise.resolve([]),
      getSettings(),
    ])
    return { snap, events, shortages, settings }
  }, [])

  const snap = data?.snap ?? EMPTY_SNAP
  const events = data?.events ?? []
  const shortages = data?.shortages ?? []
  const settings = data?.settings ?? DEFAULT_SETTINGS

  // Les aléas ajoutés par l'utilisateur doivent être résolus partout, y compris
  // dans les fonctions de calcul qui ne reçoivent pas les réglages. Le registre
  // est rafraîchi ici, au seul endroit traversé par toute l'application.
  registerCustomIncidents(settings.incidents)
  const view = deriveView(snap)
  const day = computeDayMetrics(snap, events, settings.targetRate, now)

  const live =
    view.order && view.order.status === 'open'
      ? computeLive(view.order, snap.segments, events, settings.targetRate, now)
      : undefined

  return { snap, view, events, shortages, settings, day, live, now, loading: data === undefined }
}
