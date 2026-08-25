import { useEffect, useRef, useState } from 'react'
import { playAppBeep } from '../core/audioFeedback'

interface Props {
  onAdd: (delta: number) => void
  /** Total courant, affiché dans la confirmation. */
  counted: number
  sound: boolean
  compact?: boolean
}

/**
 * Compteur de colis.
 *
 * Un appui doit se voir et s'entendre : en pleine préparation, on ne regarde pas
 * l'écran en tapant. Sans confirmation, un doigt qui glisse passe inaperçu et le
 * compte de la commande est faux jusqu'à la fin.
 *
 * Le retour combine un éclair visuel plein cadre, le total mis en avant et un
 * clic court — trois canaux, parce qu'aucun n'est fiable seul : l'écran peut
 * être dans la poche, le son couvert par l'entrepôt.
 */
export function CounterPad({ onAdd, counted, sound, compact = false }: Props) {
  const [flash, setFlash] = useState<{ delta: number; key: number } | undefined>()
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  function press(delta: number) {
    onAdd(delta)
    if (sound) playAppBeep()
    setFlash({ delta, key: Date.now() })
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setFlash(undefined), 650)
  }

  return (
    <div className="relative">
      {flash && (
        <div
          key={flash.key}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <span
            className={`tabular animate-count rounded-2xl px-5 py-2 text-4xl font-bold shadow-2xl ${
              flash.delta > 0 ? 'bg-ok text-black' : 'bg-bad text-white'
            }`}
          >
            {flash.delta > 0 ? '+' : ''}
            {flash.delta} → {counted}
          </span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => press(-1)}
          className={`pressable rounded-2xl bg-ink-700 font-bold text-slate-400 ${compact ? 'min-h-[3.25rem] text-2xl' : 'min-h-touch text-3xl'}`}
        >
          −1
        </button>
        <button
          type="button"
          onClick={() => press(1)}
          className={`pressable rounded-2xl bg-ink-600 font-bold ${compact ? 'min-h-[3.25rem] text-2xl' : 'min-h-touch text-3xl'}`}
        >
          +1
        </button>
        <button
          type="button"
          onClick={() => press(10)}
          className={`pressable rounded-2xl bg-ink-600 font-bold ${compact ? 'min-h-[3.25rem] text-2xl' : 'min-h-touch text-3xl'}`}
        >
          +10
        </button>
      </div>
    </div>
  )
}
