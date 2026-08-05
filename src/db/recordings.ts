import { db, uid } from './db'

export type RecordingEndReason = 'complete' | 'interrupted'

export interface RecordingChunk {
  id: string
  workdayId: string
  sequence: number
  startedAt: number
  endedAt: number
  duration: number
  size: number
  mimeType: string
  status: RecordingEndReason
  blob: Blob
  createdAt: number
}

export async function listRecordingChunks(workdayId: string): Promise<RecordingChunk[]> {
  return db.recordingChunks.where('workdayId').equals(workdayId).sortBy('sequence')
}

export async function nextRecordingSequence(workdayId: string): Promise<number> {
  const rows = await listRecordingChunks(workdayId)
  return (rows.at(-1)?.sequence ?? 0) + 1
}

export async function saveRecordingChunk(input: Omit<RecordingChunk, 'id' | 'createdAt'>) {
  const row: RecordingChunk = { ...input, id: uid(), createdAt: Date.now() }
  await db.recordingChunks.put(row)
  return row
}

export async function deleteRecordingChunk(id: string): Promise<void> {
  await db.recordingChunks.delete(id)
}

export async function deleteWorkdayRecordings(workdayId: string): Promise<void> {
  await db.recordingChunks.where('workdayId').equals(workdayId).delete()
}

export async function purgeExpiredRecordings(retentionDays: number, now = Date.now()): Promise<number> {
  const cutoff = now - Math.max(1, retentionDays) * 86_400_000
  return db.recordingChunks.where('createdAt').below(cutoff).delete()
}

export function recordingFilename(row: RecordingChunk): string {
  const stamp = new Date(row.startedAt).toISOString().replace(/[:.]/g, '-')
  const extension = row.mimeType.includes('mp4') ? 'mp4' : 'webm'
  return `prepatrack-${stamp}-${String(row.sequence).padStart(3, '0')}.${extension}`
}

export function downloadRecording(row: RecordingChunk): void {
  const url = URL.createObjectURL(row.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = recordingFilename(row)
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/**
 * Ouvre la feuille de partage native sur iPhone. Safari interdit à une PWA
 * d'écrire silencieusement dans Photos : l'utilisateur choisit ensuite
 * « Enregistrer la vidéo ». Le téléchargement reste le repli bureau.
 */
export async function shareRecording(row: RecordingChunk): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([row.blob], recordingFilename(row), { type: row.mimeType })
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Vidéo PrepaTrack' })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
      // Certains Safari annoncent le partage de fichiers puis le refusent :
      // le téléchargement permet encore de récupérer la vidéo.
    }
  }
  downloadRecording(row)
  return 'downloaded'
}
