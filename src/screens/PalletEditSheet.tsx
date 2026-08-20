import { useEffect, useState } from 'react'
import { BigButton } from '../components/BigButton'
import { Sheet } from '../components/Sheet'
import type { OrderPallet, SupportKind } from '../core/types'

const SUPPORTS: Array<{ key: SupportKind; label: string }> = [
  { key: 'europe', label: 'Palette Europe' },
  { key: 'ipp', label: 'Palette IPP' },
  { key: 'demi', label: 'Demi-palette' },
  { key: 'vmax', label: 'Vmax' },
  { key: 'vrac', label: 'Vrac' },
  { key: 'perdue', label: 'Palette perdue' },
]

function inputDate(value?: number): string {
  if (value === undefined) return ''
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

export function PalletEditSheet({
  pallet,
  onClose,
  onSave,
  onDelete,
}: {
  pallet?: OrderPallet
  onClose: () => void
  onSave: (patch: Partial<OrderPallet>) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const [support, setSupport] = useState<SupportKind | ''>('')
  const [startCount, setStartCount] = useState('0')
  const [endCount, setEndCount] = useState('0')
  const [startedAt, setStartedAt] = useState('')
  const [endedAt, setEndedAt] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!pallet) return
    setSupport(pallet.support ?? '')
    setStartCount(String(pallet.startCount))
    setEndCount(String(pallet.endCount ?? pallet.startCount))
    setStartedAt(inputDate(pallet.startedAt))
    setEndedAt(inputDate(pallet.endedAt))
    setConfirmDelete(false)
  }, [pallet])

  if (!pallet) return null
  return (
    <Sheet open title={`Palette ${pallet.number} · magasin ${pallet.storeNumber}`} onClose={onClose}>
      <div className="mx-auto flex max-w-md flex-col gap-3">
        <label className="text-sm font-semibold text-slate-400">
          Type de palette
          <select value={support} onChange={(e) => setSupport(e.target.value as SupportKind | '')}
            className="mt-1 min-h-touch w-full rounded-xl bg-ink-700 px-3 text-slate-200">
            <option value="">Non renseigné</option>
            {SUPPORTS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Compteur début" type="number" value={startCount} onChange={setStartCount} />
          <Field label="Compteur fin" type="number" value={endCount} onChange={setEndCount} />
          <Field label="Début" type="datetime-local" value={startedAt} onChange={setStartedAt} />
          <Field label="Fin" type="datetime-local" value={endedAt} onChange={setEndedAt} />
        </div>
        <BigButton label="Enregistrer" onClick={async () => {
          await onSave({
            support: support || undefined,
            startCount: Number(startCount),
            endCount: Number(endCount),
            startedAt: new Date(startedAt).getTime(),
            endedAt: endedAt ? new Date(endedAt).getTime() : undefined,
          })
          onClose()
        }} />
        {onDelete && (confirmDelete ? (
          <BigButton
            label="Confirmer la suppression"
            sub="La commande et la journée restent intactes"
            tone="bad"
            onClick={async () => {
              await onDelete()
              onClose()
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="pressable rounded-xl py-3 text-sm font-semibold text-bad"
          >
            Supprimer cette palette
          </button>
        ))}
      </div>
    </Sheet>
  )
}

function Field({ label, type, value, onChange }: {
  label: string
  type: string
  value: string
  onChange: (value: string) => void
}) {
  return <label className="text-xs font-semibold text-slate-400">{label}
    <input type={type} min={type === 'number' ? 0 : undefined} value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 min-h-touch w-full rounded-xl bg-ink-700 px-2 text-slate-200" />
  </label>
}
