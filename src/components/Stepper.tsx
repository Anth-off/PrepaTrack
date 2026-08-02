interface Props {
  label: string
  value: number
  onChange: (next: number) => void
  min?: number
  max?: number
}

/** Compteur +/- à grosses cibles, pour les supports en fin de commande. */
export function Stepper({ label, value, onChange, min = 0, max = 99 }: Props) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-ink-600 bg-ink-800 p-3">
      <span className="flex-1 text-lg font-semibold">{label}</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="pressable h-14 w-14 rounded-xl bg-ink-700 text-3xl font-bold disabled:opacity-30"
          aria-label={`Retirer un ${label}`}
        >
          −
        </button>
        <span
          className={`tabular w-10 text-center text-3xl font-bold ${
            value > 0 ? 'text-accent' : 'text-slate-600'
          }`}
        >
          {value}
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="pressable h-14 w-14 rounded-xl bg-ink-700 text-3xl font-bold disabled:opacity-30"
          aria-label={`Ajouter un ${label}`}
        >
          +
        </button>
      </div>
    </div>
  )
}
