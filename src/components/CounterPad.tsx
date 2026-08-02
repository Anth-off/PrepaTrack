import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  onAdd: (delta: number) => void
  /** Total courant, affiché dans la confirmation. */
  counted: number
  sound: boolean
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
export function CounterPad({ onAdd, counted, sound }: Props) {
  const [flash, setFlash] = useState<{ delta: number; key: number } | undefined>()
  const audio = useRef<AudioContext | undefined>(undefined)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
      void audio.current?.close()
    }
  }, [])

  const click = useCallback(() => {
    if (!sound) return
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      // Un seul contexte réutilisé : en créer un par appui finit par saturer
      // iOS, qui en limite le nombre.
      audio.current ??= new Ctx()
      const ctx = audio.current
      void ctx.resume()

      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = 1180
      osc.type = 'triangle'
      osc.connect(gain)
      gain.connect(ctx.destination)
      // Très court : le geste se répète des centaines de fois par vacation.
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07)
      osc.start()
      osc.stop(ctx.currentTime + 0.08)
    } catch {
      // Audio indisponible : le retour visuel suffit.
    }
  }, [sound])

  function press(delta: number) {
    onAdd(delta)
    click()
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
          className="pressable min-h-touch rounded-2xl bg-ink-700 text-3xl font-bold text-slate-400"
        >
          −1
        </button>
        <button
          type="button"
          onClick={() => press(1)}
          className="pressable min-h-touch rounded-2xl bg-ink-600 text-3xl font-bold"
        >
          +1
        </button>
        <button
          type="button"
          onClick={() => press(10)}
          className="pressable min-h-touch rounded-2xl bg-ink-600 text-3xl font-bold"
        >
          +10
        </button>
      </div>
    </div>
  )
}
