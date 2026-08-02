import { formatDuration, hhmm } from '../core/time'

interface Props {
  /** Début de la phase, pour l'affichage « depuis HH:MM ». */
  since: number
  /**
   * Durée à afficher. Sur les phases interrompues c'est le **cumul** de tous
   * les segments, pas la durée du segment courant : après un trajet, la
   * préparation reprend dans un nouveau segment et afficherait sinon « 0:00 »
   * alors que la commande est entamée depuis vingt minutes.
   */
  elapsed: number
  label: string
  emoji: string
  small?: boolean
  /** Nombre de reprises, affiché quand la phase a été interrompue. */
  resumes?: number
}

export function Chrono({ since, elapsed, label, emoji, small, resumes = 0 }: Props) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-2 text-slate-400">
        <span className="text-xl">{emoji}</span>
        <span className="text-sm font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className={`tabular font-bold ${small ? 'text-chrono-sm' : 'text-chrono'}`}>
        {formatDuration(elapsed)}
      </div>
      <div className="text-sm text-slate-500">
        depuis {hhmm(since)}
        {resumes > 0 && ` · ${resumes} reprise${resumes > 1 ? 's' : ''}`}
      </div>
    </div>
  )
}
