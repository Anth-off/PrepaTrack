import { useState } from 'react'
import { hhmm } from '../core/time'
import {
  createAccount,
  PIN_LENGTH,
  signIn,
  signOut,
  validateBadge,
  validatePin,
} from '../sync/auth'
import { clearSyncConfig, saveSyncConfig, validateConfig } from '../sync/config'
import { resetClient } from '../sync/client'
import { describeState } from '../sync/sync'
import type { SyncInfo } from '../hooks/useSync'

interface Props {
  sync: SyncInfo
}

/** Section « Synchro » des réglages : configuration, connexion, état. */
export function SyncSection({ sync }: Props) {
  if (!sync.configured) return <ConfigForm sync={sync} />
  if (!sync.profile) return <SignInForm sync={sync} />
  return <Connected sync={sync} />
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Synchro iPhone ↔ PC
      </h3>
      {children}
    </section>
  )
}

function ConfigForm({ sync }: Props) {
  const [url, setUrl] = useState('')
  const [anonKey, setAnonKey] = useState('')
  const [error, setError] = useState<string | undefined>()

  async function submit() {
    const problem = validateConfig({ url, anonKey })
    if (problem) return setError(problem)
    await saveSyncConfig({ url, anonKey })
    // Le client mémorisé pointe encore sur l'ancien projet : il doit être jeté
    // avant que quoi que ce soit ne le redemande.
    resetClient()
    await sync.refreshUser()
  }

  return (
    <Card>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        Colle ici les deux valeurs de ton projet Supabase (onglet Project Settings → API).
        La procédure complète est dans le fichier INSTALLATION.md.
      </p>
      <div className="flex flex-col gap-2">
        <Field label="Project URL" value={url} onChange={setUrl} placeholder="https://xxxxx.supabase.co" />
        <Field
          label="Clé publique (anon)"
          value={anonKey}
          onChange={setAnonKey}
          placeholder="eyJhbGciOi..."
        />
        {error && <p className="text-sm text-bad">{error}</p>}
        <button
          type="button"
          onClick={submit}
          className="pressable min-h-touch rounded-xl bg-accent font-bold text-black"
        >
          Enregistrer
        </button>
      </div>
    </Card>
  )
}

function SignInForm({ sync }: Props) {
  const [badge, setBadge] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const ready = !validateBadge(badge) && !validatePin(pin)

  async function run(action: (badge: string, pin: string) => Promise<string | undefined>) {
    const problem = validateBadge(badge) ?? validatePin(pin)
    if (problem) return setError(problem)

    setBusy(true)
    setError(undefined)
    const failure = await action(badge, pin)
    setBusy(false)
    if (failure) return setError(failure)
    // Le code n'a plus lieu d'être conservé une fois la session ouverte.
    setPin('')
    await sync.refreshUser()
    await sync.sync()
  }

  return (
    <Card>
      <p className="mb-2 mt-1 text-sm text-slate-500">
        Ton numéro de badge et ton code personnel à {PIN_LENGTH} chiffres. À ta première
        connexion, choisis ton code avec « Définir mon code ».
      </p>

      <div className="flex flex-col gap-2">
        <Field
          label="Numéro de badge"
          value={badge}
          onChange={(v) => setBadge(v.replace(/\D/g, ''))}
          placeholder="1234567"
          inputMode="numeric"
        />
        <Field
          label={`Code personnel (${PIN_LENGTH} chiffres)`}
          value={pin}
          onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, PIN_LENGTH))}
          placeholder="••••••"
          type="password"
          inputMode="numeric"
        />

        {error && <p className="text-sm text-bad">{error}</p>}

        <button
          type="button"
          onClick={() => run(signIn)}
          disabled={busy || !ready}
          className="pressable min-h-touch rounded-xl bg-accent font-bold text-black disabled:opacity-40"
        >
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
        <button
          type="button"
          onClick={() => run(createAccount)}
          disabled={busy || !ready}
          className="pressable rounded-xl bg-ink-700 py-3 text-sm font-semibold text-slate-300 disabled:opacity-40"
        >
          Première connexion — définir mon code
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-600">
        Ton badge doit avoir été déclaré par un gestionnaire. Ton code ne protège que tes
        chiffres : ne le partage pas.
      </p>
    </Card>
  )
}

function Connected({ sync }: Props) {
  const state = sync.busy ? 'running' : (sync.outcome?.state ?? 'ok')
  const tone =
    state === 'ok' ? 'text-ok' : state === 'error' ? 'text-bad' : 'text-slate-400'

  return (
    <Card>
      <div className="mt-2 flex items-baseline justify-between">
        <span className={`font-bold ${tone}`}>{describeState(state)}</span>
        {sync.pending > 0 && (
          <span className="tabular text-sm text-warn">{sync.pending} en attente</span>
        )}
      </div>

      <p className="mt-1 text-sm text-slate-500">
        {sync.profile?.name} · badge {sync.profile?.badge}
        {sync.profile?.role === 'manager' && (
          <span className="ml-2 rounded-md bg-info/20 px-1.5 py-0.5 text-xs font-bold text-info">
            gestionnaire
          </span>
        )}
        {sync.lastSyncAt && ` · synchro à ${hhmm(sync.lastSyncAt)}`}
      </p>

      {sync.outcome?.error && (
        <p className="mt-2 break-words rounded-lg bg-ink-700 p-2 text-xs text-bad">
          {sync.outcome.error}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void sync.sync()}
          disabled={sync.busy}
          className="pressable min-h-touch rounded-xl bg-ink-700 font-bold text-slate-100 disabled:opacity-40"
        >
          {sync.busy ? 'Synchro en cours…' : 'Synchroniser maintenant'}
        </button>
        <button
          type="button"
          onClick={async () => {
            await signOut()
            await sync.refreshUser()
          }}
          className="pressable rounded-xl py-2 text-sm font-semibold text-slate-400"
        >
          Se déconnecter
        </button>
        <button
          type="button"
          onClick={async () => {
            await signOut()
            await clearSyncConfig()
            resetClient()
            await sync.refreshUser()
          }}
          className="pressable rounded-xl py-2 text-xs font-semibold text-slate-600"
        >
          Changer de projet Supabase
        </button>
      </div>
    </Card>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  inputMode?: 'numeric' | 'text'
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="rounded-xl border border-ink-600 bg-ink-800 px-3 py-3 text-base"
      />
    </label>
  )
}
