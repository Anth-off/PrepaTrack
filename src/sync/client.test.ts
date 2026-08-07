import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  loadDurableAuthSession: vi.fn(),
  persistDurableAuthSession: vi.fn(),
}))

vi.mock('../native/durableStorage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../native/durableStorage')>()
  return {
    ...original,
    loadDurableAuthSession: durable.loadDurableAuthSession,
    persistDurableAuthSession: durable.persistDurableAuthSession,
  }
})

import { recoverClientAuth } from './client'

const protectedSession = JSON.stringify({
  access_token: 'access-protected',
  refresh_token: 'refresh-protected',
  expires_at: 123,
})

function fakeClient(options: { active?: Session; restored?: Session; error?: Error } = {}) {
  const getSession = vi.fn().mockResolvedValue({ data: { session: options.active ?? null } })
  const setSession = vi.fn().mockImplementation(async () => {
    if (options.error) throw options.error
    return { data: { session: options.restored ?? null }, error: null }
  })
  return {
    client: { auth: { getSession, setSession } } as unknown as SupabaseClient,
    getSession,
    setSession,
  }
}

describe('restauration automatique de la session Supabase', () => {
  beforeEach(() => {
    durable.loadDurableAuthSession.mockReset()
    durable.persistDurableAuthSession.mockReset()
  })

  it('réinjecte les jetons du Keychain lorsque la WebView a perdu sa session', async () => {
    const restored = { access_token: 'new-access', refresh_token: 'new-refresh' } as Session
    const { client, setSession } = fakeClient({ restored })
    durable.loadDurableAuthSession.mockResolvedValue(protectedSession)

    await expect(recoverClientAuth(client)).resolves.toBe(true)
    expect(setSession).toHaveBeenCalledWith({
      access_token: 'access-protected',
      refresh_token: 'refresh-protected',
    })
    expect(durable.persistDurableAuthSession).toHaveBeenCalledWith(JSON.stringify(restored))
  })

  it('ne touche pas au Keychain lorsque la session est encore active', async () => {
    const active = { access_token: 'active' } as Session
    const { client, setSession } = fakeClient({ active })

    await expect(recoverClientAuth(client)).resolves.toBe(true)
    expect(durable.loadDurableAuthSession).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
  })

  it('conserve le filet protégé si le réseau empêche la restauration', async () => {
    const { client } = fakeClient({ error: new TypeError('Failed to fetch') })
    durable.loadDurableAuthSession.mockResolvedValue(protectedSession)

    await expect(recoverClientAuth(client)).resolves.toBe(false)
    expect(durable.persistDurableAuthSession).not.toHaveBeenCalled()
  })
})
