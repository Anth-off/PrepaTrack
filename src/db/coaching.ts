import type { CoachingAlert } from '../core/types'
import { scheduleDurableBackup } from '../native/durableStorage'
import { db, uid } from './db'

export async function coachingAlertsFor(workdayId: string): Promise<CoachingAlert[]> {
  const rows = await db.coachingAlerts.where('workdayId').equals(workdayId).toArray()
  return rows.filter((row) => !row.deletedAt).sort((a, b) => b.at - a.at)
}

export async function saveCoachingAlert(
  alert: Omit<CoachingAlert, 'id' | 'updatedAt' | 'syncState'>,
): Promise<CoachingAlert> {
  const row: CoachingAlert = { ...alert, id: uid(), updatedAt: Date.now(), syncState: 'pending' }
  await db.coachingAlerts.put(row)
  scheduleDurableBackup()
  return row
}

export async function markCoachingAlertRead(id: string, at = Date.now()): Promise<void> {
  await db.coachingAlerts.where('id').equals(id).modify((row) => {
    row.readAt = at
    row.updatedAt = at
    row.syncState = 'pending'
  })
  scheduleDurableBackup()
}

export async function supersedeCoachingAlerts(workdayId: string, after: number, at = Date.now()): Promise<number> {
  let changed = 0
  await db.coachingAlerts.where('workdayId').equals(workdayId).modify((row) => {
    if (row.at < after || row.supersededAt || row.deletedAt) return
    row.supersededAt = at
    row.updatedAt = at
    row.syncState = 'pending'
    changed += 1
  })
  if (changed > 0) scheduleDurableBackup()
  return changed
}

export function canRepeatCoachingAlert(
  previous: CoachingAlert | undefined,
  cause: CoachingAlert['cause'],
  delayPackages: number,
  now: number,
): boolean {
  if (!previous || previous.cause !== cause) return true
  if (now - previous.at >= 15 * 60_000) return true
  return delayPackages - previous.delayPackages >= 15
}
