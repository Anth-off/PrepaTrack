import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, wipeAll } from './db'
import {
  deleteWorkdayRecordings,
  listRecordingChunks,
  nextRecordingSequence,
  purgeExpiredRecordings,
  saveRecordingChunk,
} from './recordings'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

function chunk(workdayId: string, sequence: number, createdAt?: number) {
  return {
    workdayId,
    sequence,
    startedAt: sequence * 1_000,
    endedAt: sequence * 1_000 + 500,
    duration: 500,
    size: 3,
    mimeType: 'video/mp4',
    status: 'complete' as const,
    blob: new Blob(['abc'], { type: 'video/mp4' }),
    ...(createdAt ? { createdAt } : {}),
  }
}

describe('archives vidéo locales', () => {
  it('classe les extraits et calcule la séquence suivante par vacation', async () => {
    await saveRecordingChunk(chunk('w1', 2))
    await saveRecordingChunk(chunk('w1', 1))
    await saveRecordingChunk(chunk('w2', 8))
    expect((await listRecordingChunks('w1')).map((row) => row.sequence)).toEqual([1, 2])
    expect(await nextRecordingSequence('w1')).toBe(3)
  })

  it('supprime une vacation sans toucher aux médias des autres', async () => {
    await saveRecordingChunk(chunk('w1', 1))
    await saveRecordingChunk(chunk('w2', 1))
    await deleteWorkdayRecordings('w1')
    expect(await db.recordingChunks.count()).toBe(1)
  })

  it('purge la rétention et efface physiquement les médias lors de la remise à zéro', async () => {
    const old = await saveRecordingChunk(chunk('w1', 1))
    await db.recordingChunks.update(old.id, { createdAt: 1 })
    expect(await purgeExpiredRecordings(1, 86_400_002)).toBe(1)
    await saveRecordingChunk(chunk('w1', 2))
    await wipeAll()
    expect(await db.recordingChunks.count()).toBe(0)
  })
})
