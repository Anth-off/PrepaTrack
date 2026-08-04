import { useLiveQuery } from 'dexie-react-hooks'
import type { DayData } from '../core/analysis'
import type { Snapshot } from '../core/machine'
import { computeDayMetrics } from '../core/metrics'
import type { Settings } from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'
import { getSettings } from '../db/db'
import { colisEventsFor, listWorkdays, loadSnapshotFor, stockShortagesFor } from '../db/repo'

/** Une vacation, avec tout ce qu'il faut pour l'analyser. */
export interface RecentDay extends DayData {
  snap: Snapshot
  open: boolean
  /**
   * Vacation restée ouverte bien au-delà d'un poste : le chrono a continué de
   * tourner toute la nuit. Sa durée n'a plus de sens et écraserait toutes les
   * moyennes, elle est donc écartée des agrégats jusqu'à correction.
   */
  stale: boolean
}

/** Au-delà, une vacation encore ouverte est forcément un oubli de clôture. */
export const STALE_AFTER = 16 * 3600_000

export interface RecentDays {
  days: RecentDay[]
  settings: Settings
  targetRate: number
  loading: boolean
}

/**
 * Les N dernières vacations, la plus récente en tête. Segments et comptages
 * sont chargés avec : les analyses croisées en ont besoin, et un second passage
 * en base pour les récupérer ferait clignoter tout le tableau de bord.
 */
export function useRecentDays(limit = 30): RecentDays {
  const data = useLiveQuery(async () => {
    const [workdays, settings] = await Promise.all([listWorkdays(limit), getSettings()])
    const days = await Promise.all(
      workdays.map(async (workday) => {
        const [snap, events, shortages] = await Promise.all([
          loadSnapshotFor(workday),
          colisEventsFor(workday.id),
          stockShortagesFor(workday.id),
        ])
        const metrics = computeDayMetrics(snap, events, settings.targetRate)
        const open = workday.status === 'open'
        return {
          id: workday.id,
          date: workday.date,
          snap,
          open,
          stale: open && metrics.presence > STALE_AFTER,
          segments: snap.segments,
          events,
          shortages,
          metrics,
        }
      }),
    )
    return { days, settings }
  }, [limit])

  return {
    days: data?.days ?? [],
    settings: data?.settings ?? DEFAULT_SETTINGS,
    targetRate: data?.settings.targetRate ?? 110,
    loading: data === undefined,
  }
}
