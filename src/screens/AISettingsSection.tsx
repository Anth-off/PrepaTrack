import { useState } from 'react'
import type { Settings } from '../core/types'
import { INCIDENT_TYPES, segmentDef } from '../core/segments'
import type { OfflineCoachControl } from '../hooks/useOfflineCoach'

export function AISettingsSection({ settings, coach }: { settings: Settings; coach: OfflineCoachControl }) {
  const [message, setMessage] = useState<string>()
  const percent = coach.progress && coach.progress.total > 0
    ? Math.min(100, Math.round(coach.progress.downloaded / coach.progress.total * 100))
    : undefined
  const size = coach.status.bytes ? `${Math.round(coach.status.bytes / 1024 / 1024)} Mo` : 'environ 379 Mo'

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Coach IA hors ligne</h3>
          <p className="mt-1 text-sm text-slate-500">
            Les calculs restent déterministes. Le modèle local ne fait que rédiger l'explication.
          </p>
        </div>
        <Toggle checked={settings.ai.enabled} disabled={!coach.status.ready}
          onChange={(value) => void coach.setEnabled(value)} />
      </div>

      <div className="mt-3 rounded-xl bg-ink-900 px-3 py-3 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-slate-500">Modèle</span>
          <strong className={coach.status.ready ? 'text-ok' : 'text-slate-300'}>
            {coach.status.ready ? `Installé · ${size}` : `Non installé · ${size}`}
          </strong>
        </div>
        {coach.status.version && <div className="mt-1 text-right text-xs text-slate-600">{coach.status.version}</div>}
        {percent !== undefined && (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded-full bg-ink-600">
              <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
            </div>
            <p className="mt-1 text-right text-xs text-slate-500">Téléchargement Wi‑Fi · {percent} %</p>
          </div>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        {!coach.status.ready ? (
          <button type="button" disabled={coach.busy || !coach.status.available} onClick={() => void coach.download()}
            className="pressable min-h-touch flex-1 rounded-xl bg-accent px-3 font-bold text-black disabled:opacity-50">
            {!coach.status.available ? 'Disponible sur iPhone' : coach.busy ? 'Téléchargement…' : 'Télécharger en Wi‑Fi'}
          </button>
        ) : (
          <button type="button" disabled={coach.busy} onClick={() => void coach.removeModel()}
            className="pressable min-h-touch flex-1 rounded-xl border border-bad/40 px-3 font-semibold text-bad">
            Supprimer le modèle
          </button>
        )}
      </div>

      {coach.status.ready && (
        <div className="mt-4 flex flex-col gap-3 border-t border-ink-600 pt-3">
          <SettingToggle label="Analyse visuelle locale" detail="Flux arrière échantillonné sans conserver d'image."
            checked={settings.ai.visionEnabled} onChange={(value) => void coach.setVisionEnabled(value)} />
          <SettingToggle label="Collecte volontaire" detail="Conserve uniquement les images capturées manuellement."
            checked={settings.ai.trainingCollectionEnabled}
            onChange={(value) => void coach.setTrainingEnabled(value)} />
          {settings.ai.trainingCollectionEnabled && (
            <div className="rounded-xl bg-ink-900 p-3">
              <p className="mb-2 text-xs text-slate-500">Étiquette la dernière image arrière disponible :</p>
              <div className="grid grid-cols-2 gap-2">
                {INCIDENT_TYPES.slice(0, 6).map((type) => (
                  <button key={type} type="button" className="pressable rounded-lg bg-ink-700 px-2 py-2 text-xs font-semibold"
                    onClick={() => void coach.capture(type).then(() => setMessage(`Image « ${segmentDef(type).short} » conservée localement.`)).catch(() => setMessage('Aucune image disponible.'))}>
                    {segmentDef(type).emoji} {segmentDef(type).short}
                  </button>
                ))}
              </div>
              <button type="button" className="pressable mt-2 w-full rounded-lg bg-ink-700 py-2 text-sm font-semibold"
                onClick={() => void coach.exportTraining()}>Exporter la collecte</button>
            </div>
          )}
        </div>
      )}
      {(coach.error || message) && <p className="mt-3 text-sm text-warn">{coach.error ?? message}</p>}
      <p className="mt-3 text-xs text-slate-600">
        Vision {coach.status.visionEnabled ? 'active' : 'inactive'} · température {coach.status.thermal ?? 'inconnue'} · échantillonnage {coach.status.samplingSeconds ?? '—'} s
      </p>
    </section>
  )
}

function SettingToggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <div className="flex items-center justify-between gap-3"><div><strong className="text-sm">{label}</strong><p className="text-xs text-slate-500">{detail}</p></div><Toggle checked={checked} onChange={onChange} /></div>
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
    className={`relative h-8 w-14 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-ink-600'} disabled:opacity-40`}>
    <span className={`absolute top-1 h-6 w-6 rounded-full bg-white transition ${checked ? 'left-7' : 'left-1'}`} />
  </button>
}
