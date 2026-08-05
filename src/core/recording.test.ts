import { describe, expect, it } from 'vitest'
import {
  MIN_FREE_RECORDING_BYTES,
  estimatedRecordingMegabytes,
  mediaErrorMessage,
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
  })
})
