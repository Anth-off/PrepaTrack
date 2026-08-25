import { describe, expect, it } from 'vitest'
import {
  MIN_FREE_RECORDING_BYTES,
  RECORDING_CHUNK_MS,
  estimatedRecordingMegabytes,
  estimatedNativeRecordingMegabytes,
  mediaErrorMessage,
  recordingRecoveryMessage,
  recordingStorageWarning,
  selectRecordingMime,
} from './recording'

describe('politique d’enregistrement local', () => {
  it('privilégie le MP4 compatible avec iOS puis retombe sur WebM', () => {
    expect(selectRecordingMime((mime) => mime === 'video/mp4')).toBe('video/mp4')
    expect(selectRecordingMime((mime) => mime === 'video/webm')).toBe('video/webm')
    expect(selectRecordingMime(() => false)).toBeUndefined()
  })

  it('bloque avant de saturer le stockage et avertit en amont', () => {
    expect(recordingStorageWarning({ quota: 1_000_000_000, usage: 1_000_000_000 - MIN_FREE_RECORDING_BYTES + 1 })).toContain('insuffisant')
    expect(recordingStorageWarning({ quota: 1_000_000_000, usage: 600_000_000 })).toContain('bientôt')
    expect(recordingStorageWarning({ quota: 2_000_000_000, usage: 100_000_000 })).toBeUndefined()
  })

  it('donne des erreurs compréhensibles sans toucher aux données métier', () => {
    expect(mediaErrorMessage(new DOMException('', 'NotAllowedError'))).toContain('refusé')
    expect(mediaErrorMessage(new DOMException('', 'NotFoundError'))).toContain('introuvable')
    expect(estimatedRecordingMegabytes(7.5)).toBeGreaterThan(1_000)
    expect(RECORDING_CHUNK_MS).toBe(30 * 60_000)
    expect(estimatedRecordingMegabytes(7.5)).toBeGreaterThan(5_000)
    expect(estimatedNativeRecordingMegabytes(7.5)).toBeGreaterThan(24_000)
  })

  it('explique le résultat de la récupération des vidéos locales', () => {
    expect(recordingRecoveryMessage({ pending: 0, recovered: 0, retained: 0 }))
      .toBe('Aucune vidéo locale en attente de récupération.')
    expect(recordingRecoveryMessage({ pending: 2, recovered: 2, retained: 0 }))
      .toBe('2 vidéos récupérées et ajoutées à Photos.')
    expect(recordingRecoveryMessage({ pending: 0, recovered: 2, retained: 0 }))
      .toBe('2 vidéos récupérées et ajoutées à Photos.')
    expect(recordingRecoveryMessage({ pending: 2, recovered: 1, retained: 1 }))
      .toBe('1 vidéo récupérée. 1 vidéo reste conservée localement pour une prochaine tentative.')
    expect(recordingRecoveryMessage({ pending: 2, recovered: 0, retained: 2, error: 'Photos indisponible' }))
      .toBe('2 vidéos restent conservées localement. Récupération incomplète : Photos indisponible')
  })
})
