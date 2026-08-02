import { useEffect, useState } from 'react'

/**
 * Horloge de rendu. Les durées ne sont jamais accumulées : ce hook ne fait que
 * provoquer un re-rendu périodique, l'affichage étant toujours recalculé depuis
 * les horodatages stockés. Un écran verrouillé pendant vingt minutes affiche
 * donc la bonne valeur dès le déverrouillage.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = () => setNow(Date.now())
    const id = window.setInterval(tick, intervalMs)
    // iOS gèle les timers en arrière-plan : on resynchronise au retour.
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', tick)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', tick)
    }
  }, [intervalMs])

  return now
}
