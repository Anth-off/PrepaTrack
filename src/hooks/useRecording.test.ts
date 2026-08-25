import { describe, expect, it } from 'vitest'
import {
  RECORDING_INTENT_RETRY_DELAYS_MS,
  RECORDING_INTENT_STORAGE_KEY,
  clearPersistentRecordingIntent,
  parsePersistentRecordingIntent,
  readPersistentRecordingIntent,
  rememberPersistentRecordingIntent,
  shouldClearPersistentRecordingIntent,
  shouldResumePersistentRecording,
} from './useRecording'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

describe('intention persistante de captation', () => {
  it('mémorise la journée uniquement après un démarrage confirmé', () => {
    const storage = new MemoryStorage()

    expect(rememberPersistentRecordingIntent('day-06', storage, 1_723_000)).toBe(true)
    expect(storage.getItem(RECORDING_INTENT_STORAGE_KEY)).toBe(
      JSON.stringify({ version: 1, workdayId: 'day-06', requestedAt: 1_723_000 }),
    )
    expect(readPersistentRecordingIntent(storage)).toEqual({
      version: 1,
      workdayId: 'day-06',
      requestedAt: 1_723_000,
    })
  })

  it('ne reprend que le module activé pour la même journée encore ouverte', () => {
    const intent = parsePersistentRecordingIntent(
      JSON.stringify({ version: 1, workdayId: 'day-06', requestedAt: 1_723_000 }),
    )

    expect(shouldResumePersistentRecording(intent, 'day-06', true)).toBe(true)
    expect(shouldResumePersistentRecording(intent, 'day-07', true)).toBe(false)
    expect(shouldResumePersistentRecording(intent, 'day-06', false)).toBe(false)
    expect(shouldResumePersistentRecording(intent, undefined, true)).toBe(false)
  })

  it('ignore une intention corrompue au lieu de démarrer une mauvaise captation', () => {
    expect(parsePersistentRecordingIntent('{')).toBeUndefined()
    expect(parsePersistentRecordingIntent(JSON.stringify({ version: 1, workdayId: '' }))).toBeUndefined()
    expect(parsePersistentRecordingIntent(JSON.stringify({ version: 2, workdayId: 'day-06', requestedAt: 1 }))).toBeUndefined()
  })

  it('efface explicitement l’intention lors de l’arrêt volontaire', () => {
    const storage = new MemoryStorage()
    rememberPersistentRecordingIntent('day-06', storage, 1)

    clearPersistentRecordingIntent(storage)

    expect(readPersistentRecordingIntent(storage)).toBeUndefined()
  })

  it('préserve l’intention pendant l’hydratation puis l’efface aux fins volontaires', () => {
    const loading = { enabled: false, workdayId: undefined }

    expect(shouldClearPersistentRecordingIntent(loading, loading)).toBe(false)
    expect(shouldClearPersistentRecordingIntent(loading, { enabled: true, workdayId: 'day-06' })).toBe(false)
    // Une rotation de fichier, un verrouillage ou une interruption native ne
    // change ni le réglage ni la journée : l'intention doit donc survivre.
    expect(shouldClearPersistentRecordingIntent(
      { enabled: true, workdayId: 'day-06' },
      { enabled: true, workdayId: 'day-06' },
    )).toBe(false)
    expect(shouldClearPersistentRecordingIntent(
      { enabled: true, workdayId: 'day-06' },
      { enabled: false, workdayId: 'day-06' },
    )).toBe(true)
    expect(shouldClearPersistentRecordingIntent(
      { enabled: true, workdayId: 'day-06' },
      { enabled: true, workdayId: undefined },
    )).toBe(true)
    expect(shouldClearPersistentRecordingIntent(
      { enabled: true, workdayId: 'day-06' },
      { enabled: true, workdayId: 'day-restored' },
    )).toBe(false)
    expect(shouldClearPersistentRecordingIntent(loading, { enabled: false, workdayId: 'day-06' })).toBe(true)
  })

  it('borne les reprises automatiques avec un backoff prudent', () => {
    expect(RECORDING_INTENT_RETRY_DELAYS_MS).toEqual([0, 5_000, 30_000])
  })

  it('n’interrompt pas la captation si le stockage navigateur est indisponible', () => {
    const unavailable = {
      getItem: () => { throw new Error('indisponible') },
      setItem: () => { throw new Error('indisponible') },
      removeItem: () => { throw new Error('indisponible') },
    }

    expect(rememberPersistentRecordingIntent('day-06', unavailable, 1)).toBe(false)
    expect(readPersistentRecordingIntent(unavailable)).toBeUndefined()
    expect(() => clearPersistentRecordingIntent(unavailable)).not.toThrow()
  })
})
