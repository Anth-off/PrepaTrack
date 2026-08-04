import { describe, expect, it } from 'vitest'
import { appUpdatePolicy } from './appUpdate'

describe('politique de mise à jour', () => {
  it('propose l’installation quand aucune vacation n’est ouverte', () => {
    expect(
      appUpdatePolicy({ updateReady: true, workdayActive: false, online: true }),
    ).toEqual({
      notice: 'actionable',
      activationAllowed: true,
      currentVersionUsable: true,
    })
  })

  it('diffère strictement l’activation pendant une vacation', () => {
    expect(
      appUpdatePolicy({ updateReady: true, workdayActive: true, online: true }),
    ).toEqual({
      notice: 'deferred',
      activationAllowed: false,
      currentVersionUsable: true,
    })
  })

  it('laisse la version actuelle utilisable hors ligne sans afficher d’erreur', () => {
    expect(
      appUpdatePolicy({ updateReady: false, workdayActive: true, online: false }),
    ).toEqual({
      notice: 'hidden',
      activationAllowed: false,
      currentVersionUsable: true,
    })
  })

  it('peut installer hors ligne une version déjà intégralement téléchargée', () => {
    expect(
      appUpdatePolicy({ updateReady: true, workdayActive: false, online: false }),
    ).toMatchObject({ notice: 'actionable', activationAllowed: true })
  })
})
