import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getSettings, saveSettings, wipeAll } from '../db/db'
import type { Settings } from '../core/types'
import type { SyncInfo } from '../hooks/useSync'
import type { CartMotionControl } from '../hooks/useCartMotion'
import { BackupSection } from './BackupSection'
import { CartMotionSection } from './CartMotionSection'
import { DiagnosticSection } from './DiagnosticSection'
import { HelpSection } from './HelpSection'
import { SyncSection } from './SyncSection'

/** Réglages. Tout est modifiable sans intervention sur le code. */
export function SettingsScreen({
  sync,
  motion,
}: {
  sync: SyncInfo
  motion: CartMotionControl
}) {
  const settings = useLiveQuery(() => getSettings(), [])
  const [confirmWipe, setConfirmWipe] = useState(false)
  if (!settings) return <p className="px-4 py-8 text-center text-slate-500">Chargement…</p>

  const patch = (p: Partial<Settings>) => saveSettings(p)

  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <HelpSection role={sync.profile?.role} />

      <BackupSection />

      <SyncSection sync={sync} />

      <section className="card">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Objectif
        </h3>
        <NumberRow
          label="Colis par heure"
          value={settings.targetRate}
          min={10}
          max={400}
          step={5}
          onChange={(targetRate) => patch({ targetRate })}
        />
      </section>

      <CartMotionSection settings={settings} motion={motion} />

      <section className="card">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Pauses
        </h3>
        <NumberRow
          label="Petite pause (min)"
          value={settings.shortBreakMinutes}
          min={5}
          max={30}
          onChange={(shortBreakMinutes) => patch({ shortBreakMinutes })}
        />
        <NumberRow
          label="Nombre de petites pauses"
          value={settings.shortBreaksPerDay}
          min={0}
          max={5}
          onChange={(shortBreaksPerDay) => patch({ shortBreaksPerDay })}
        />
        <NumberRow
          label="Grande pause (min)"
          value={settings.longBreakMinutes}
          min={10}
          max={90}
          step={5}
          onChange={(longBreakMinutes) => patch({ longBreakMinutes })}
        />
        <NumberRow
          label="Nombre de grandes pauses"
          value={settings.longBreaksPerDay}
          min={0}
          max={3}
          onChange={(longBreaksPerDay) => patch({ longBreaksPerDay })}
        />
      </section>

      <section className="card">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Alertes « chrono oublié »
        </h3>
        <p className="mb-2 text-sm text-slate-500">
          Au-delà de ces durées, l'app signale un chrono probablement resté ouvert.
        </p>
        <NumberRow
          label="Interruption (min)"
          value={settings.stuckThresholds.interruption}
          min={5}
          max={90}
          step={5}
          onChange={(v) =>
            patch({ stuckThresholds: { ...settings.stuckThresholds, interruption: v } })
          }
        />
        <NumberRow
          label="Pause (min)"
          value={settings.stuckThresholds.break}
          min={10}
          max={120}
          step={5}
          onChange={(v) => patch({ stuckThresholds: { ...settings.stuckThresholds, break: v } })}
        />
        <NumberRow
          label="Commande (min)"
          value={settings.stuckThresholds.order}
          min={30}
          max={400}
          step={10}
          onChange={(v) => patch({ stuckThresholds: { ...settings.stuckThresholds, order: v } })}
        />
      </section>

      <IncidentEditor settings={settings} />

      <section className="card">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Données
        </h3>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          Efface toutes les journées et commandes enregistrées. À utiliser une fois les
          essais terminés, avant de commencer à s'en servir pour de vrai. Les réglages
          ci-dessus sont conservés. Si la synchro est active, l'effacement est aussi
          répercuté sur l'autre appareil.
        </p>
        {confirmWipe ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={async () => {
                await wipeAll()
                setConfirmWipe(false)
              }}
              className="pressable min-h-touch rounded-xl bg-bad font-bold text-white"
            >
              Oui, tout effacer définitivement
            </button>
            <button
              type="button"
              onClick={() => setConfirmWipe(false)}
              className="pressable rounded-xl bg-ink-700 py-3 font-semibold text-slate-300"
            >
              Annuler
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmWipe(true)}
            className="pressable w-full rounded-xl border border-bad/40 py-3 text-sm font-semibold text-bad"
          >
            Effacer toutes les données
          </button>
        )}
      </section>

      <DiagnosticSection />

      <p className="text-center text-xs text-slate-600">PrepaTrack</p>
    </div>
  )
}

const SUGGESTED_EMOJI = ['📦', '🚫', '💥', '🔍', '❄️', '🧾', '🚧', '🅿️']

/**
 * Éditeur des types d'aléas.
 *
 * Un aléa supprimé reste résolu à l'affichage par le registre de repli : les
 * journées où il avait servi gardent un libellé lisible plutôt qu'un écran cassé.
 */
function IncidentEditor({ settings }: { settings: Settings }) {
  const [label, setLabel] = useState('')
  const [emoji, setEmoji] = useState(SUGGESTED_EMOJI[0])
  const [error, setError] = useState<string | undefined>()

  async function add() {
    const name = label.trim()
    if (name.length < 2) return setError('Donne un nom à cet aléa.')
    if (settings.incidents.some((i) => i.label.toLowerCase() === name.toLowerCase())) {
      return setError('Un aléa porte déjà ce nom.')
    }
    setError(undefined)
    await saveSettings({
      incidents: [
        ...settings.incidents,
        // Clé stable et unique : renommer l'aléa plus tard ne doit pas couper le
        // lien avec les segments déjà enregistrés.
        { key: `custom_${Date.now().toString(36)}`, label: name, emoji },
      ],
    })
    setLabel('')
  }

  async function remove(key: string) {
    await saveSettings({ incidents: settings.incidents.filter((i) => i.key !== key) })
  }

  async function rename(key: string, next: string) {
    await saveSettings({
      incidents: settings.incidents.map((i) => (i.key === key ? { ...i, label: next } : i)),
    })
  }

  return (
    <section className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Types d'aléas
      </h3>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        Les boutons proposés derrière « Aléa » pendant la vacation. Cinq maximum, pour
        rester utilisables d'un coup d'œil.
      </p>

      <ul className="flex flex-col gap-2">
        {settings.incidents.map((incident) => (
          <li key={incident.key} className="flex items-center gap-2">
            <span className="w-8 text-center text-xl">{incident.emoji}</span>
            <input
              value={incident.label}
              onChange={(e) => rename(incident.key, e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-900 px-2 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => remove(incident.key)}
              className="pressable rounded-lg bg-ink-700 px-3 py-2 text-sm font-semibold text-bad"
              aria-label={`Supprimer ${incident.label}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {settings.incidents.length < 5 && (
        <div className="mt-3 border-t border-ink-600 pt-3">
          <div className="mb-2 flex flex-wrap gap-1">
            {SUGGESTED_EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEmoji(e)}
                className={`pressable h-9 w-9 rounded-lg text-lg ${
                  emoji === e ? 'bg-accent' : 'bg-ink-700'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Rupture, article introuvable…"
              className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 text-sm"
            />
            <button
              type="button"
              onClick={add}
              className="pressable rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-black"
            >
              Ajouter
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-bad">{error}</p>}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-600">
        Ces réglages restent sur cet appareil : ils ne suivent pas la synchro. Chacun a donc
        ses propres aléas, ce qui est voulu — mais pense à les recréer si tu changes de
        téléphone.
      </p>
    </section>
  )
}

function NumberRow({
  label,
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="flex-1 text-sm">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - step))}
          className="pressable h-11 w-11 rounded-lg bg-ink-700 text-xl font-bold"
        >
          −
        </button>
        <span className="tabular w-12 text-center text-xl font-bold">{value}</span>
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + step))}
          className="pressable h-11 w-11 rounded-lg bg-ink-700 text-xl font-bold"
        >
          +
        </button>
      </div>
    </div>
  )
}
