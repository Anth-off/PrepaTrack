interface Props {
  value: string
  onChange: (next: string) => void
  max?: number
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']

/**
 * Pavé numérique maison plutôt que le clavier iOS : celui-ci met une seconde à
 * s'ouvrir, réduit la zone visible de moitié et propose des touches minuscules.
 */
export function NumPad({ value, onChange, max = 9999 }: Props) {
  function press(key: string) {
    if (key === 'C') return onChange('')
    if (key === '⌫') return onChange(value.slice(0, -1))
    const next = (value + key).replace(/^0+(?=\d)/, '')
    if (Number(next) > max) return
    onChange(next)
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => press(key)}
          className={`pressable h-16 rounded-xl text-2xl font-bold tabular ${
            key === 'C' || key === '⌫'
              ? 'bg-ink-700 text-slate-400'
              : 'bg-ink-700 text-slate-100'
          }`}
        >
          {key}
        </button>
      ))}
    </div>
  )
}
