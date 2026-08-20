import { estimatedRecordingMegabytes } from '../core/recording'
import type { Settings } from '../core/types'
import type { RecordingControl } from '../hooks/useRecording'
import { saveSettings } from '../db/db'
import { RecordingControl as RecordingControlBar } from '../components/RecordingControl'

export function RecordingSettingsSection({ settings, recording }: { settings: Settings; recording: RecordingControl }) {
  const config = settings.recording
  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Enregistrement de la vacation</h3>
          <p className="mt-1 text-sm text-slate-500">Caméra avant et micro du téléphone. Tu peux laisser ta musique tourner : le casque n’est pas utilisé comme micro.</p>
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
            Qualité équilibrée 720p à 30 i/s : environ {estimatedRecordingMegabytes(7.5)} Mo pour 7 h 30, en extraits de 10 minutes maximum. Sur iPhone, le zoom avant reste à son minimum et la meilleure stabilisation cinématique disponible est activée. La musique peut continuer pendant la captation : le micro intégré et l’annulation d’écho visent à n’enregistrer presque que ta voix, pas le casque. Chaque extrait est d’abord sécurisé dans le stockage durable, puis ajouté à Photos en arrière-plan. Après une veille, une fermeture ou un crash, les fichiers restants sont récupérés au prochain lancement. Les vidéos sont exclues de Supabase et des sauvegardes JSON.
          </p>
          <button
            type="button"
            onClick={() => void recording.testDevices()}
            className="pressable mt-3 w-full rounded-xl bg-ink-700 py-3 text-sm font-semibold"
          >
            Tester la caméra et le microphone
          </button>
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
