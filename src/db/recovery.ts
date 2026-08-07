import { dayKey } from '../core/time'
import type { Workday } from '../core/types'
import { db } from './db'

/**
 * Répare le cas d'une ligne `workday` absente alors que sa timeline existe
 * encore. Une suppression volontaire marque aussi les segments comme supprimés
 * et n'est donc jamais ressuscitée par cette procédure.
 */
export async function recoverOrphanedWorkdays(): Promise<number> {
  const segments = (await db.segments.toArray()).filter((segment) => !segment.deletedAt)
  const byDay = new Map<string, typeof segments>()
  for (const segment of segments) {
    const rows = byDay.get(segment.workdayId) ?? []
    rows.push(segment)
    byDay.set(segment.workdayId, rows)
  }

  let recovered = 0
  for (const [workdayId, rows] of byDay) {
    const existing = await db.workdays.get(workdayId)
    if (existing && !existing.deletedAt) continue
    rows.sort((a, b) => a.startedAt - b.startedAt)
    const open = rows.some((row) => row.endedAt === undefined)
    const ended = rows.flatMap((row) => row.endedAt === undefined ? [] : [row.endedAt])
    const workday: Workday = {
      ...existing,
      id: workdayId,
      date: dayKey(rows[0].startedAt),
      status: open ? 'open' : 'closed',
      startedAt: rows[0].startedAt,
      endedAt: open || ended.length === 0 ? undefined : Math.max(...ended),
      ownerId: existing?.ownerId ?? rows.find((row) => row.ownerId)?.ownerId,
      updatedAt: Date.now(),
      syncState: 'pending',
      deletedAt: undefined,
      notes: 'Vacation reconstruite automatiquement depuis la timeline locale.',
    }
    await db.workdays.put(workday)
    recovered += 1
  }
  return recovered
}
