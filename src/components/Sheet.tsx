import type { ReactNode } from 'react'
import { useEffect } from 'react'

interface Props {
  open: boolean
  title: string
  onClose?: () => void
  children: ReactNode
}

/**
 * Panneau plein écran. Volontairement non fermable par simple tap à côté quand
 * `onClose` n'est pas fourni : les saisies de fin de commande ne doivent pas
 * pouvoir être perdues d'un geste involontaire.
 */
export function Sheet({ open, title, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900">
      <div className="safe-top flex items-center justify-between border-b border-ink-600 px-4 pb-3">
        <h2 className="text-lg font-bold">{title}</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="pressable rounded-xl bg-ink-700 px-4 py-2 text-sm font-semibold text-slate-300"
          >
            Annuler
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </div>
  )
}
