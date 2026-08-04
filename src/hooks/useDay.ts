import { useLiveQuery } from 'dexie-react-hooks'
import type { Snapshot } from '../core/machine'
import { computeDayMetrics, type DayMetrics } from '../core/metrics'
import type { ColisEvent, Settings, StockShortage } from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'
import { getSettings } from '../db/db'
import { colisEventsFor, loadSnapshotById, stockShortagesFor } from '../db/repo'
import { useNow } from './useNow'

export interface DayView {
  snap?: Snapshot
  events: ColisEvent[]
  shortages: StockShortage[]
  day?: DayMetrics
  settings: Settings
  targetRate: number
  loading: boolean
}

/** Charge une vacation précise (passée ou en cours) et ses métriques. */
export function useDay(workdayId?: string): DayView {
  // Une journée close ne bouge plus : inutile de rafraîchir chaque seconde.
  const now = useNow(15_000)

  const data = useLiveQuery(async () => {
    if (!workdayId) return null
    const snap = await loadSnapshotById(workdayId)
    if (!snap?.workday) return null
    const [events, shortages, settings] = await Promise.all([
      colisEventsFor(snap.workday.id),
      stockShortagesFor(snap.workday.id),
      getSettings(),
    ])
    return { snap, events, shortages, settings }
  }, [workdayId])

  if (!data) {
    return {
      events: [], shortages: [], settings: DEFAULT_SETTINGS,
      targetRate: 110, loading: data === undefined,
    }
  }

  return {
    snap: data.snap,
    events: data.events,
    shortages: data.shortages,
    settings: data.settings,
    day: computeDayMetrics(data.snap, data.events, data.settings.targetRate, now),
    targetRate: data.settings.targetRate,
    loading: false,
  }
}
