import { describe, expect, it } from 'vitest'
import { downloadProgressFromStatus } from './offlineAI'

describe('downloadProgressFromStatus', () => {
  it('restaure un téléchargement silencieux depuis l’état natif', () => {
    expect(downloadProgressFromStatus({
      available: true,
      ready: false,
      version: 'test',
      bytes: 400,
      downloadState: 'waiting-wifi',
      downloaded: 0,
      downloadTotal: 400,
      downloadMessage: 'En attente du Wi-Fi',
    })).toEqual({
      state: 'waiting-wifi',
      downloaded: 0,
      total: 400,
      bytesPerSecond: undefined,
      message: 'En attente du Wi-Fi',
    })
  })

  it('ne maintient pas une progression une fois le modèle installé', () => {
    expect(downloadProgressFromStatus({
      available: true,
      ready: true,
      version: 'test',
      bytes: 400,
      downloadState: 'completed',
    })).toBeUndefined()
  })
})
