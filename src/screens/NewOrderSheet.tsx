import { useState } from 'react'
import { BigButton } from '../components/BigButton'
import { NumPad } from '../components/NumPad'
import { Sheet } from '../components/Sheet'
import { TargetReference } from '../components/TargetReference'
import { contextualTarget } from '../core/contextualTarget'
import type { DayData } from '../core/analysis'
import type { OrderType } from '../core/types'

interface Props {
  open: boolean
  historyDays: DayData[]
  manualRate: number
  onCancel: () => void
  onConfirm: (input: { colisPlanned: number; linesCount: number; orderType: OrderType }) => void
}

const TYPES: { value: OrderType; label: string }[] = [
  { value: 'normale', label: 'Normale' },
  { value: 'urbaine', label: 'Urbaine' },
  { value: 'geprocor', label: 'Geprocor' },
]

/**
 * Un seul pavé numérique partagé entre les deux champs : on tape sur le champ à
 * remplir, on saisit, le focus passe tout seul au suivant. Trois taps de moins
 * qu'avec deux champs séparés, et le clavier iOS n'apparaît jamais.
 */
export function NewOrderSheet({ open, historyDays, manualRate, onCancel, onConfirm }: Props) {
  const [colis, setColis] = useState('')
  const [lines, setLines] = useState('')
  const [field, setField] = useState<'colis' | 'lines'>('colis')
  const [orderType, setOrderType] = useState<OrderType>('normale')

  const colisNum = Number(colis || 0)
  const linesNum = Number(lines || 0)
  const ready = colisNum > 0
  const reference = contextualTarget(
    historyDays,
    { orderType, colis: colisNum, linesCount: linesNum },
    manualRate,
  )

  function reset() {
    setColis('')
    setLines('')
    setField('colis')
    setOrderType('normale')
  }

  function handleChange(next: string) {
    if (field === 'colis') {
      setColis(next)
      // Le nombre de colis dépasse rarement 3 chiffres : on bascule tout seul.
      if (next.length === 3) setField('lines')
    } else {
      setLines(next)
    }
  }

  return (
    <Sheet
      open={open}
      title="Nouvelle commande"
      onClose={() => {
        reset()
        onCancel()
      }}
    >
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <FieldBox
            label="Colis"
            value={colis}
            active={field === 'colis'}
            onClick={() => setField('colis')}
          />
          <FieldBox
            label="Lignes"
            value={lines}
            active={field === 'lines'}
            onClick={() => setField('lines')}
            hint="facultatif"
          />
        </div>

        <NumPad value={field === 'colis' ? colis : lines} onChange={handleChange} />

        <div className="grid grid-cols-3 gap-2">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setOrderType(t.value)}
              className={`pressable min-h-[3.5rem] rounded-xl px-2 text-base font-bold ${
                orderType === t.value ? 'bg-info text-black' : 'bg-ink-700 text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <TargetReference reference={reference} />

        <BigButton
          label="Lancer la commande"
          sub={ready ? `${colisNum} colis · ${linesNum || '?'} lignes` : 'Saisis le nombre de colis'}
          disabled={!ready}
          onClick={() => {
            onConfirm({ colisPlanned: colisNum, linesCount: linesNum, orderType })
            reset()
          }}
        />
      </div>
    </Sheet>
  )
}

function FieldBox({
  label,
  value,
  active,
  onClick,
  hint,
}: {
  label: string
  value: string
  active: boolean
  onClick: () => void
  hint?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border-2 p-3 text-left ${
        active ? 'border-accent bg-ink-700' : 'border-ink-600 bg-ink-800'
      }`}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label} {hint && <span className="normal-case text-slate-600">· {hint}</span>}
      </div>
      <div className="tabular mt-1 text-4xl font-bold">
        {value || <span className="text-slate-700">0</span>}
      </div>
    </button>
  )
}
