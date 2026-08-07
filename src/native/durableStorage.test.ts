import { describe, expect, it } from 'vitest'
import { authSessionTokens, newestAuthSession } from './durableStorage'

const session = (expiresAt: number, token: string) =>
  JSON.stringify({ access_token: token, refresh_token: `refresh-${token}`, expires_at: expiresAt })

describe('récupération de la session Supabase protégée', () => {
  it('restaure le Keychain lorsque le stockage WebView est vide', () => {
    const durable = session(200, 'durable')
    expect(newestAuthSession(undefined, durable)).toBe(durable)
  })

  it('ne rétrograde jamais une session locale plus récente', () => {
    const local = session(300, 'local')
    const durable = session(200, 'durable')
    expect(newestAuthSession(local, durable)).toBe(local)
  })

  it('utilise le Keychain seulement lorsqu’il est réellement plus récent', () => {
    const local = session(200, 'local')
    const durable = session(300, 'durable')
    expect(newestAuthSession(local, durable)).toBe(durable)
  })

  it('préfère la session active si les formats ne donnent aucune date', () => {
    expect(newestAuthSession('{"token":"local"}', '{"token":"durable"}')).toBe('{"token":"local"}')
  })

  it('extrait les jetons nécessaires à une restauration Supabase', () => {
    expect(authSessionTokens(session(300, 'safe'))).toEqual({
      access_token: 'safe',
      refresh_token: 'refresh-safe',
    })
  })

  it('refuse une copie Keychain tronquée au lieu de casser le démarrage', () => {
    expect(authSessionTokens('{"access_token":"incomplet"}')).toBeUndefined()
    expect(authSessionTokens('json cassé')).toBeUndefined()
  })
})
