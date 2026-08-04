import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getSettings, saveSettings } from './db'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('réglages du détecteur de trajet', () => {
  it("conserve l'activation après fermeture et réouverture de l'application", async () => {
    await saveSettings({
      cartMotion: {
        enabled: true,
        stationaryEnergy: 0.2,
        movingEnergy: 1.8,
        threshold: 1,
      },
    })

    db.close()
    await db.open()

    expect((await getSettings()).cartMotion).toEqual({
      enabled: true,
      stationaryEnergy: 0.2,
      movingEnergy: 1.8,
      threshold: 1,
    })
  })

  it("ne désactive pas le détecteur lors d'une mise à jour partielle", async () => {
    await saveSettings({ cartMotion: { enabled: true, threshold: 1 } })

    await saveSettings({ cartMotion: { stationaryEnergy: 0.3 } })

    expect((await getSettings()).cartMotion).toMatchObject({
      enabled: true,
      stationaryEnergy: 0.3,
      threshold: 1,
    })
  })
})
