import { useCallback, useEffect, useRef, useState } from 'react'
import { buildResumeSummary, type ResumeSummary } from '../core/resume'
import type { Session } from './useSession'

const LAST_VISIBLE_KEY = 'prepatrack:last-visible-at'
const HEARTBEAT_MS = 30_000

function readLastVisible(): number | undefined {
  try {
    const value = Number(window.localStorage.getItem(LAST_VISIBLE_KEY))
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function writeLastVisible(at: number): void {
  try {
    window.localStorage.setItem(LAST_VISIBLE_KEY, String(at))
  } catch {
    // Le résumé reste calculable depuis le début du segment si le stockage est bloqué.
  }
}

/** Détecte un vrai retour au travail, sans écrire dans les données métier. */
export interface ResumePromptControl {
  summary?: ResumeSummary
  continueWithoutChanges: () => void
}

export function useResumePrompt(session: Session): ResumePromptControl {
  const [summary, setSummary] = useState<ResumeSummary>()
  const sessionRef = useRef(session)
  const bootChecked = useRef(false)
  const activeId = session.view.active?.id

  useEffect(() => {
    sessionRef.current = session
  })

  const continueWithoutChanges = useCallback(() => {
    writeLastVisible(Date.now())
    setSummary(undefined)
  }, [])

  const checkReturn = useCallback(() => {
    const current = sessionRef.current
    if (current.loading || document.hidden) return
    const now = Date.now()
    const next = buildResumeSummary({
      snap: current.snap,
      view: current.view,
      settings: current.settings,
      lastSeenAt: readLastVisible(),
      now,
    })
    writeLastVisible(now)
    if (next) setSummary(next)
  }, [])

  // Au lancement, IndexedDB doit d'abord rendre le vrai segment. Une valeur par
  // défaut ne doit jamais produire une fenêtre fantôme.
  useEffect(() => {
    if (session.loading || bootChecked.current) return
    bootChecked.current = true
    checkReturn()
  }, [checkReturn, session.loading])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) writeLastVisible(Date.now())
      else checkReturn()
    }
    const onPageHide = () => writeLastVisible(Date.now())
    const heartbeat = window.setInterval(() => {
      if (!document.hidden && !sessionRef.current.loading) writeLastVisible(Date.now())
    }, HEARTBEAT_MS)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', checkReturn)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.clearInterval(heartbeat)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', checkReturn)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [checkReturn])

  // Une action utilisateur a déjà remplacé le segment présenté : le résumé est
  // devenu caduc et ne doit jamais agir sur le nouveau chrono.
  useEffect(() => {
    if (summary && activeId !== summary.segmentId) setSummary(undefined)
  }, [activeId, summary])

  return { summary, continueWithoutChanges }
}
