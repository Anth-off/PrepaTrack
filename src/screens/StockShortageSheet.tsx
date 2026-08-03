import { useEffect, useState } from 'react'
import { BigButton } from '../components/BigButton'
import { Sheet } from '../components/Sheet'
import type { StockShortage } from '../core/types'
import type { StockShortageInput } from '../db/repo'

interface Props {
  shortage?: StockShortage
  onClose: () => void
  onSave: (input: StockShortageInput) => Promise<void>
  onDelete: () => Promise<void>
  onSetResolved: (resolved: boolean) => Promise<void>
}

/** Correction a posteriori uniquement : le signalement en prépa reste un appui direct. */
export function StockShortageSheet({
  shortage,
  onClose,
  onSave,
  onDelete,
  onSetResolved,
}: Props) {
  const [quantity, setQuantity] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!shortage) return
    setQuantity(String(shortage.quantity))
    setSaving(false)
    setError(undefined)
  }, [shortage])

  if (!shortage) return null

  async function save() {
    const parsed = Number(quantity)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError('Indique une quantité entière strictement positive.')
      return
    }
    setSaving(true)
    await onSave({ quantity: parsed })
    onClose()
  }

  return (
    <Sheet open title="Corriger le hors stock" onClose={saving ? undefined : onClose}>
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-semibold text-slate-300">
          Nombre de colis hors stock
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ''))}
            className="min-h-touch rounded-xl border border-ink-600 bg-ink-800 px-4 text-2xl font-bold"
            autoFocus
          />
        </label>

        {error && <p role="alert" className="text-sm font-semibold text-bad">{error}</p>}
        <BigButton label={saving ? 'Enregistrement…' : 'Enregistrer'} onClick={save} disabled={saving} />

        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true)
            await onSetResolved(!shortage.resolved)
            onClose()
          }}
          className="pressable rounded-xl bg-ink-700 py-3 font-semibold text-slate-300"
        >
          {shortage.resolved ? 'Marquer comme non résolu' : 'Marquer comme résolu'}
        </button>

        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true)
            await onDelete()
            onClose()
          }}
          className="pressable rounded-xl border border-bad/50 py-3 font-semibold text-bad"
        >
          Supprimer ce comptage
        </button>
      </div>
    </Sheet>
  )
}
