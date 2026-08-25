export interface FeedbackBeepOptions {
  frequency?: number
  times?: number
  spacingSeconds?: number
  peakGain?: number
}

let sharedContext: AudioContext | undefined

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

/**
 * Joue le son seulement après la reprise effective du contexte. Sur iOS,
 * programmer puis arrêter l'oscillateur pendant que le contexte est suspendu
 * faisait disparaître aléatoirement le clic avant que `resume()` se termine.
 */
export async function playFeedbackBeep(
  context: AudioContext,
  options: FeedbackBeepOptions = {},
): Promise<void> {
  if (context.state !== 'running') await context.resume()
  if (context.state !== 'running') throw new Error('Contexte audio indisponible')

  const frequency = options.frequency ?? 1_180
  const times = options.times ?? 1
  const spacing = options.spacingSeconds ?? 0.35
  const peak = options.peakGain ?? 0.22

  for (let index = 0; index < times; index += 1) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const start = context.currentTime + 0.005 + index * spacing
    oscillator.frequency.value = frequency
    oscillator.type = 'triangle'
    oscillator.connect(gain)
    gain.connect(context.destination)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.07)
    oscillator.start(start)
    oscillator.stop(start + 0.08)
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect()
      gain.disconnect()
    }, { once: true })
  }
}

/** Un unique contexte partagé évite la limite iOS et reste amorcé pour les alertes. */
export function playAppBeep(options: FeedbackBeepOptions = {}): void {
  try {
    const Ctx = audioContextConstructor()
    if (!Ctx) return
    if (!sharedContext || sharedContext.state === 'closed') sharedContext = new Ctx()
    void playFeedbackBeep(sharedContext, options).catch(() => {
      // Le retour visuel reste disponible si iOS interrompt momentanément l'audio.
    })
  } catch {
    // Même garantie : aucun son ne doit bloquer l'enregistrement d'un colis.
  }
}
