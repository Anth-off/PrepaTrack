import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getSettings, restoreMissingMeta, saveSettings } from './db'

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

describe('récupération des métadonnées natives', () => {
  it('restaure une configuration absente', async () => {
    expect(await restoreMissingMeta([{ key: 'supabase', value: { url: 'native' } }])).toBe(1)
    expect(await db.meta.get('supabase')).toEqual({ key: 'supabase', value: { url: 'native' } })
  })

  it('ne remplace jamais une configuration locale encore présente', async () => {
    await db.meta.put({ key: 'supabase', value: { url: 'local-plus-recent' } })

    expect(await restoreMissingMeta([{ key: 'supabase', value: { url: 'ancienne-copie-native' } }])).toBe(0)
    expect((await db.meta.get('supabase'))?.value).toEqual({ url: 'local-plus-recent' })
  })

  it('respecte une suppression locale explicite', async () => {
    await db.meta.put({ key: 'profile', value: undefined })

    expect(await restoreMissingMeta([{ key: 'profile', value: { userId: 'ancien' } }])).toBe(0)
    expect(await db.meta.get('profile')).toEqual({ key: 'profile', value: undefined })
  })
})
