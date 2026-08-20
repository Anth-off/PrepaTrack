import { estimatedNativeRecordingMegabytes, estimatedRecordingMegabytes } from '../core/recording'
import type { Settings } from '../core/types'
import type { RecordingControl } from '../hooks/useRecording'
import { saveSettings } from '../db/db'
import { RecordingControl as RecordingControlBar } from '../components/RecordingControl'
import { nativeRecordingSupported } from '../native/recording'

export function RecordingSettingsSection({ settings, recording }: { settings: Settings; recording: RecordingControl }) {
  const config = settings.recording
  const estimatedMegabytes = nativeRecordingSupported()
    ? estimatedNativeRecordingMegabytes(7.5)
    : estimatedRecordingMegabytes(7.5)
  const recoveryDisabled = recording.recovering || ['recording', 'requesting', 'stopping'].includes(recording.status)
  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Enregistrement de la vacation</h3>
          <p className="mt-1 text-sm text-slate-500">Caméras avant/arrière et microphone, avec indicateur iOS visible.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          onClick={() => void saveSettings({ recording: { enabled: !config.enabled } })}
          className={`pressable min-h-11 rounded-full px-4 text-sm font-bold ${config.enabled ? 'bg-accent text-black' : 'bg-ink-700 text-slate-400'}`}
        >
          {config.enabled ? 'Activé' : 'Désactivé'}
        </button>
      </div>

      <div className="mt-3 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs leading-relaxed text-slate-300">
        iOS affiche son indicateur caméra/micro dans la Dynamic Island pendant toute captation. Préviens les personnes filmées et respecte les règles de ton lieu de travail.
      </div>

      {config.enabled && (
        <>
          <label className="mt-3 flex items-center justify-between gap-3 text-sm">
            Conservation locale
            <select
              value={config.retentionDays}
              onChange={(event) => void saveSettings({ recording: { retentionDays: Number(event.target.value) } })}
              className="rounded-lg bg-ink-700 px-3 py-2 font-semibold"
            >
              <option value={1}>1 jour</option>
              <option value={3}>3 jours</option>
              <option value={7}>7 jours</option>
            </select>
          </label>
          <p className="mt-2 text-xs text-slate-500">
            Qualité équilibrée 720p à 30 i/s : environ {estimatedMegabytes} Mo pour 7 h 30. Chaque tranche de 30 minutes crée deux vidéos séparées et plein cadre, une AVANT et une ARRIÈRE, puis la tranche suivante démarre automatiquement. Un bandeau discret avec l’angle, la date et l’heure est gravé dans la zone visible des miniatures Photos. Le micro est d’abord écrit en PCM 48 kHz dans un fichier résistant aux extinctions brutales, puis ajouté aux deux vidéos. Le démarrage n’est confirmé qu’après écriture réelle des deux angles et du micro. iOS applique le mode choisi : Automatique, Standard, Isolement de la voix ou Large spectre. Les sources restent dans le stockage durable jusqu’à confirmation de l’import des deux vidéos dans Photos, puis elles sont récupérées automatiquement après une interruption. Les vidéos sont exclues de Supabase et des sauvegardes JSON.
          </p>
          <button
            type="button"
            onClick={() => void recording.testDevices()}
            className="pressable mt-3 w-full rounded-xl bg-ink-700 py-3 text-sm font-semibold"
          >
            Tester la caméra et le microphone
          </button>
          <button
            type="button"
            onClick={() => void recording.showMicrophoneModes()}
            className="pressable mt-2 w-full rounded-xl bg-ink-700 py-3 text-sm font-semibold"
          >
            Choisir le mode micro iOS
          </button>
          <p className="mt-1 text-xs text-slate-500">Le choix est possible avant ou pendant la captation et reste mémorisé par iOS pour PrepaTrack.</p>
          <button
            type="button"
            disabled={recoveryDisabled}
            aria-busy={recording.recovering}
            onClick={() => void recording.recoverVideos()}
            className="pressable mt-3 w-full rounded-xl bg-ink-700 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {recording.recovering ? 'Récupération en cours…' : 'Récupérer les vidéos locales'}
          </button>
          {recoveryDisabled && !recording.recovering && (
            <p className="mt-1 text-xs text-slate-500">Arrête la captation avant de lancer une récupération.</p>
          )}
          {recording.recoveryMessage && (
            <p role="status" aria-live="polite" className="mt-2 text-xs text-slate-400">{recording.recoveryMessage}</p>
          )}
          {recording.message && <p role="status" className="mt-2 text-xs text-slate-400">{recording.message}</p>}
          <div className="mt-3">
            <RecordingControlBar recording={recording} />
          </div>
          {!recording.canStart && (
            <p className="mt-2 text-xs text-slate-500">Commence d’abord une journée, puis reviens ici pour démarrer la captation.</p>
          )}
        </>
      )}
    </section>
  )
}
