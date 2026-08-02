import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  advanceOrder,
  closeWorkdayAt,
  endBriefing,
  loadSnapshot,
  loadSnapshotById,
  plausibleEndFor,
  startDay,
  startOrder,
} from './repo'
import { segmentDuration } from '../core/metrics'
import { MINUTE } from '../core/time'

/**
 * Réparation d'une vacation oubliée. Le piège est de clôturer à l'heure
 * actuelle : un oubli de la veille produirait une journée de quarante heures,
 * qui écraserait les moyennes de tout le mois.
 */

const START = new Date(2026, 7, 3, 13, 0, 0).getTime()
const at = (minutes: number) => START + minutes * MINUTE

beforeEach(async () => {
  await db.delete()
  await db.open()
})

/** Vacation ouverte avec une commande dont le prélèvement n'est jamais fermé. */
async function forgottenShift(orderStart = 20, setupEnd = 26): Promise<string> {
  await startDay(at(0))
  await endBriefing(at(12))
  await startOrder({ colisPlanned: 100, linesCount: 25, orderType: 'normale' }, at(orderStart))
  if (setupEnd > orderStart) await advanceOrder(at(setupEnd))
  const snap = await loadSnapshot()
  return snap.workday!.id
}

describe('clôture d’une vacation oubliée', () => {
  it('propose l’heure du dernier chrono terminé', async () => {
    const id = await forgottenShift()
    // Dernier segment terminé : la recherche de palette, close à 13h26.
    expect(await plausibleEndFor(id)).toBe(at(26))
  })

  it('clôt la journée, la commande et les chronos restés ouverts', async () => {
    const id = await forgottenShift()
    await closeWorkdayAt(id, at(26))

    const snap = (await loadSnapshotById(id))!
    expect(snap.workday!.status).toBe('closed')
    expect(snap.workday!.endedAt).toBe(at(26))
    expect(snap.orders[0].status).toBe('done')
    expect(snap.segments.every((s) => s.endedAt !== undefined)).toBe(true)
  })

  it('garde une durée plausible plutôt que l’heure actuelle', async () => {
    const id = await forgottenShift()
    const end = await plausibleEndFor(id)
    await closeWorkdayAt(id, end!)

    const snap = (await loadSnapshotById(id))!
    const presence = snap.workday!.endedAt! - snap.workday!.startedAt
    // 26 minutes, pas les dizaines d'heures écoulées depuis l'oubli.
    expect(presence).toBe(26 * MINUTE)
  })

  it('ne crée jamais de durée négative', async () => {
    // Le prélèvement démarre à 13h30 et reste ouvert.
    const id = await forgottenShift(30, 0)
    // Heure de clôture antérieure au début du dernier segment.
    await closeWorkdayAt(id, at(5))

    const snap = (await loadSnapshotById(id))!
    for (const segment of snap.segments) {
      expect(segmentDuration(segment)).toBeGreaterThanOrEqual(0)
    }
    expect(snap.workday!.endedAt).toBeGreaterThanOrEqual(at(30))
  })

  it('laisse la timeline continue après clôture', async () => {
    const id = await forgottenShift()
    await closeWorkdayAt(id, at(80))

    const snap = (await loadSnapshotById(id))!
    const segs = snap.segments
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].startedAt).toBe(segs[i - 1].endedAt)
    }
    const total = segs.reduce((sum, s) => sum + segmentDuration(s), 0)
    expect(total).toBe(snap.workday!.endedAt! - snap.workday!.startedAt)
  })

  it('ne rouvre pas la vacation clôturée au démarrage suivant', async () => {
    const id = await forgottenShift()
    await closeWorkdayAt(id, at(26))
    // Une fois réparée, l'application ne doit plus la considérer en cours.
    expect((await loadSnapshot()).workday).toBeUndefined()
  })
})
