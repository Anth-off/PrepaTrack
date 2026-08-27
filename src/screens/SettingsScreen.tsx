import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getSettings, saveSettings, wipeAll } from '../db/db'
import type { Settings } from '../core/types'
import type { SyncInfo } from '../hooks/useSync'
import type { CartMotionControl } from '../hooks/useCartMotion'
import type { AppUpdateControl } from '../hooks/useAppUpdate'
import type { RecordingControl } from '../hooks/useRecording'
import type { OfflineCoachControl } from '../hooks/useOfflineCoach'
import { AISettingsSection } from './AISettingsSection'
import { RecordingSettingsSection } from './RecordingSettingsSection'
import { INCIDENT_TYPES, segmentDef } from '../core/segments'
import { BackupSection } from './BackupSection'
import { CartMotionSection } from './CartMotionSection'
import { DiagnosticSection } from './DiagnosticSection'
import { HelpSection } from './HelpSection'
import { SyncSection } from './SyncSection'

/** Réglages. Tout est modifiable sans intervention sur le code. */
export function SettingsScreen({
  sync,
  motion,
  update,
  recording,
  coach,
}: {
  sync: SyncInfo
  motion: CartMotionControl
  update: AppUpdateControl
  recording: RecordingControl
  coach: OfflineCoachControl
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

      <RecordingSettingsSection settings={settings} recording={recording} />

      <AISettingsSection settings={settings} coach={coach} />

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

      <IncidentList />

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

      <DiagnosticSection update={update} />

      <p className="text-center text-xs text-slate-600">
        PrepaTrack ·{' '}
        <a
          href="https://github.com/N0thyTVOff/PrepaTrack"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          code source (AGPL-3.0)
        </a>
      </p>
    </div>
  )
}

/** Liste fixe et identique sur tous les appareils. */
function IncidentList() {
  return (
    <section className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Types d'aléas
      </h3>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        Matériel, circulation, supports, stock et sécurité : les mêmes motifs restent
        disponibles sur l'iPhone et le PC, même hors ligne.
      </p>

      <ul className="flex flex-col gap-2">
        {INCIDENT_TYPES.map((type) => (
          <li key={type} className="flex items-center gap-3 rounded-lg bg-ink-900 px-3 py-2">
            <span className="w-8 text-center text-xl">{segmentDef(type).emoji}</span>
            <span className="text-sm font-semibold text-slate-200">{segmentDef(type).short}</span>
          </li>
        ))}
      </ul>
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
