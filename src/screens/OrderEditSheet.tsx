import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { BigButton } from '../components/BigButton'
import { NumPad } from '../components/NumPad'
import { Sheet } from '../components/Sheet'
import { Stepper } from '../components/Stepper'
import { countedColis } from '../core/metrics'
import type { Order, OrderType, SupportKind, Supports } from '../core/types'
import { EMPTY_SUPPORTS } from '../core/types'
import { db } from '../db/db'
import { deleteOrder, updateOrder } from '../db/repo'

interface Props {
  order?: Order
  onClose: () => void
}

const SUPPORT_LABELS: { key: SupportKind; label: string }[] = [
  { key: 'europe', label: 'Palette Europe' },
  { key: 'ipp', label: 'Palette IPP' },
  { key: 'demi', label: 'Demi-palette' },
  { key: 'vmax', label: 'Vmax' },
  { key: 'vrac', label: 'Vrac' },
  { key: 'perdue', label: 'Palette perdue' },
]

const TYPES: { value: OrderType; label: string }[] = [
  { value: 'normale', label: 'Normale' },
  { value: 'urbaine', label: 'Urbaine' },
  { value: 'geprocor', label: 'Geprocor' },
]

/**
 * Correction d'une commande déjà terminée.
 *
 * Le nombre de lignes est modifiable au même titre que les colis : c'est lui qui
 * détermine la densité, donc la cadence attendue. Une commande saisie sans ses
 * lignes reste hors de toute comparaison tant qu'elle n'est pas complétée.
 */
export function OrderEditSheet({ order, onClose }: Props) {
  const [colis, setColis] = useState('')
  const [lines, setLines] = useState('')
  const [field, setField] = useState<'colis' | 'lines'>('colis')
  const [orderType, setOrderType] = useState<OrderType>('normale')
  const [supports, setSupports] = useState<Supports>({ ...EMPTY_SUPPORTS })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const events = useLiveQuery(
    () => (order ? db.colisEvents.where('orderId').equals(order.id).toArray() : []),
    [order?.id],
  ) ?? []
  const counted = order ? countedColis(events, order.id) : 0

  useEffect(() => {
    if (!order) return
    setColis(String(order.colisActual ?? order.colisPlanned))
    setLines(order.linesCount > 0 ? String(order.linesCount) : '')
    setOrderType(order.orderType)
    setSupports({ ...EMPTY_SUPPORTS, ...order.supports })
    setField('colis')
    setConfirmDelete(false)
  }, [order])

  if (!order) return null

  async function save() {
    if (!order) return
    await updateOrder(order.id, {
      colisActual: Number(colis || 0),
      linesCount: Number(lines || 0),
      orderType,
      supports,
    })
    onClose()
  }

  return (
    <Sheet open title="Corriger la commande" onClose={onClose}>
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
          />
        </div>

        {counted > 0 && counted !== Number(colis || 0) && (
          <p className="text-sm text-warn">
            {counted} appuis de picking enregistrés. Enregistrer réaligne le
            compteur sur {colis || '0'} colis, sans toucher au reste de la journée.
          </p>
        )}
        {counted > 0 && counted === Number(colis || 0) && (
          <p className="text-xs text-slate-500">
            {counted} appuis de picking, alignés avec ce total.
          </p>
        )}

        <NumPad
          value={field === 'colis' ? colis : lines}
          onChange={(v) => (field === 'colis' ? setColis(v) : setLines(v))}
        />

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

        <div className="flex flex-col gap-2">
          {SUPPORT_LABELS.map(({ key, label }) => (
            <Stepper
              key={key}
              label={label}
              value={supports[key]}
              onChange={(v) => setSupports((s) => ({ ...s, [key]: v }))}
            />
          ))}
        </div>

        <BigButton label="Enregistrer" onClick={save} />

        {confirmDelete ? (
          <BigButton
            label="Confirmer la suppression"
            sub="La journée et les autres commandes restent intactes"
            tone="bad"
            onClick={async () => {
              await deleteOrder(order.id)
              onClose()
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="pressable rounded-xl py-3 text-sm font-semibold text-bad"
          >
            Supprimer cette commande
          </button>
        )}
      </div>
    </Sheet>
  )
}

function FieldBox({
  label,
  value,
  active,
  onClick,
}: {
  label: string
  value: string
  active: boolean
  onClick: () => void
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
        {label}
      </div>
      <div className="tabular mt-1 text-4xl font-bold">
        {value || <span className="text-slate-700">0</span>}
      </div>
    </button>
  )
}
