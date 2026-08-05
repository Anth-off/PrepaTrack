/** Un fichier reste maniable, mais les raccords sont limités à un toutes les 30 minutes. */
export const RECORDING_CHUNK_MS = 30 * 60_000
export const RECORDING_VIDEO_BITS_PER_SECOND = 1_500_000
export const RECORDING_AUDIO_BITS_PER_SECOND = 64_000
export const RECORDING_BITS_PER_SECOND =
  RECORDING_VIDEO_BITS_PER_SECOND + RECORDING_AUDIO_BITS_PER_SECOND
export const MIN_FREE_RECORDING_BYTES = 150 * 1024 * 1024

const MIME_CANDIDATES = [
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

export function selectRecordingMime(isSupported: (mime: string) => boolean): string | undefined {
  return MIME_CANDIDATES.find(isSupported)
}

export function recordingSupported(scope: Pick<typeof globalThis, 'MediaRecorder' | 'navigator'> = globalThis): boolean {
  return Boolean(scope.MediaRecorder && scope.navigator?.mediaDevices?.getUserMedia)
}

export function recordingStorageWarning(estimate?: { quota?: number; usage?: number }): string | undefined {
  if (!estimate?.quota) return undefined
  const free = estimate.quota - (estimate.usage ?? 0)
  if (free < MIN_FREE_RECORDING_BYTES) return 'Espace insuffisant pour démarrer un nouvel extrait.'
  if (free < 500 * 1024 * 1024) return 'Espace bientôt insuffisant : exporte ou supprime d’anciennes vidéos.'
  return undefined
}

export function mediaErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') return 'Accès à la caméra ou au micro refusé.'
  if (name === 'NotFoundError') return 'Caméra avant ou microphone introuvable.'
  if (name === 'NotReadableError') return 'Caméra ou microphone déjà utilisé par une autre application.'
  return error instanceof Error ? error.message : 'Impossible de démarrer l’enregistrement.'
}

export function estimatedRecordingMegabytes(hours: number): number {
  return Math.round((RECORDING_BITS_PER_SECOND * hours * 3600) / 8 / 1_000_000)
}
