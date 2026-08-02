import { useEffect, useState } from 'react'

/**
 * Suit une media query en JavaScript. Réservé aux cas où la mise en page ne
 * suffit pas — choisir l'écran ouvert au démarrage, par exemple. Tout ce qui
 * peut être fait en CSS doit l'être : c'est plus rapide et ça ne clignote pas
 * au premier rendu.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )

  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return matches
}

/** Seuil unique de bascule vers la présentation bureau. */
export const DESKTOP_QUERY = '(min-width: 768px)'
