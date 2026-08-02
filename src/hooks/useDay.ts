import { useLiveQuery } from 'dexie-react-hooks'
import type { Snapshot } from '../core/machine'
import { computeDayMetrics, type DayMetrics } from '../core/metrics'
import type { ColisEvent } from '../core/types'
import { getSettings } from '../db/db'
import { colisEventsFor, loadSnapshotById } from '../db/repo'
import { useNow } from './useNow'

export interface DayView {
  snap?: Snapshot
  events: ColisEvent[]
  day?: DayMetrics
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
    const [events, settings] = await Promise.all([
      colisEventsFor(snap.workday.id),
      getSettings(),
    ])
    return { snap, events, targetRate: settings.targetRate }
  }, [workdayId])

  if (!data) {
    return { events: [], targetRate: 110, loading: data === undefined }
  }

  return {
    snap: data.snap,
    events: data.events,
    day: computeDayMetrics(data.snap, data.events, data.targetRate, now),
    targetRate: data.targetRate,
    loading: false,
  }
}
