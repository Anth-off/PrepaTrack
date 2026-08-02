import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { downloadBackup, restoreBackup } from '../db/backup'
import { db } from '../db/db'

/**
 * Sauvegarde locale. Placée avant tout le reste dans les réglages : c'est la
 * première chose à faire avant de changer d'hébergement, de téléphone, ou de
 * toucher à la synchro.
 */
export function BackupSection() {
  const [message, setMessage] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const counts = useLiveQuery(async () => {
    const [workdays, orders, segments] = await Promise.all([
      db.workdays.filter((w) => !w.deletedAt).count(),
      db.orders.filter((o) => !o.deletedAt).count(),
      db.segments.filter((s) => !s.deletedAt).count(),
    ])
    return { workdays, orders, segments }
  }, [])

  async function save() {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const how = await downloadBackup()
      setMessage(
        how === 'shared'
          ? 'Choisis « Enregistrer dans Fichiers » ou envoie-toi le fichier.'
          : 'Fichier téléchargé.',
      )
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setError('Export annulé.')
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function restore(file: File) {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const result = await restoreBackup(await file.text())
      setMessage(
        `Restauration terminée : ${result.added} ajouté(s), ${result.updated} mis à jour, ${result.skipped} déjà à jour.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <section className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Sauvegarde
      </h3>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        {counts
          ? `${counts.workdays} journée(s), ${counts.orders} commande(s), ${counts.segments} chronos enregistrés.`
          : 'Lecture…'}{' '}
        Le fichier contient tout et se relit sur n'importe quel appareil.
      </p>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="pressable min-h-touch rounded-xl bg-accent font-bold text-black disabled:opacity-40"
        >
          Exporter une sauvegarde
        </button>

        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="pressable rounded-xl bg-ink-700 py-3 text-sm font-semibold text-slate-300 disabled:opacity-40"
        >
          Restaurer un fichier
        </button>

        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void restore(file)
          }}
        />
      </div>

      {message && <p className="mt-2 text-sm text-ok">{message}</p>}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}

      <p className="mt-3 text-xs text-slate-600">
        La restauration fusionne sans rien écraser : une donnée locale plus récente que
        celle du fichier est conservée.
      </p>
    </section>
  )
}
