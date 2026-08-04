import { useState } from 'react'
import { BigButton } from '../components/BigButton'
import { NumPad } from '../components/NumPad'
import { Sheet } from '../components/Sheet'
import { TargetReference } from '../components/TargetReference'
import { Stepper } from '../components/Stepper'
import { contextualTarget } from '../core/contextualTarget'
import type { DayData } from '../core/analysis'
import type { OrderType } from '../core/types'

interface Props {
  open: boolean
  historyDays: DayData[]
  manualRate: number
  onCancel: () => void
  onConfirm: (input: {
    colisPlanned: number
    linesCount: number
    orderType: OrderType
    storeCount: 1 | 2
    initialPallets: [number, number]
  }) => void
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
  const [storeCount, setStoreCount] = useState<1 | 2>(1)
  const [initialPallets, setInitialPallets] = useState<[number, number]>([1, 1])

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
    setStoreCount(1)
    setInitialPallets([1, 1])
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

        <div>
          <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Magasins dans la commande
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([1, 2] as const).map((count) => (
              <button
                key={count}
                type="button"
                onClick={() => setStoreCount(count)}
                className={`pressable min-h-[3.5rem] rounded-xl font-bold ${
                  storeCount === count ? 'bg-accent text-black' : 'bg-ink-700 text-slate-300'
                }`}
              >
                {count} magasin{count > 1 ? 's' : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Palettes présentes au départ
          </div>
          <Stepper
            label={storeCount === 2 ? 'Magasin 1' : 'Palettes'}
            value={initialPallets[0]}
            min={1}
            max={10}
            onChange={(value) => setInitialPallets((current) => [value, current[1]])}
          />
          {storeCount === 2 && (
            <Stepper
              label="Magasin 2"
              value={initialPallets[1]}
              min={1}
              max={10}
              onChange={(value) => setInitialPallets((current) => [current[0], value])}
            />
          )}
          <p className="text-xs text-slate-500">
            Tu pourras encore ajouter une palette lors de la clôture.
          </p>
        </div>

        <TargetReference reference={reference} />

        <BigButton
          label="Lancer la commande"
          sub={ready ? `${colisNum} colis · ${linesNum || '?'} lignes` : 'Saisis le nombre de colis'}
          disabled={!ready}
          onClick={() => {
            onConfirm({
              colisPlanned: colisNum,
              linesCount: linesNum,
              orderType,
              storeCount,
              initialPallets,
            })
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
