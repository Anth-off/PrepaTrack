import { useEffect, useState } from 'react'
import { BigButton } from '../components/BigButton'
import { NumPad } from '../components/NumPad'
import { Sheet } from '../components/Sheet'
import { TargetReference } from '../components/TargetReference'
import { contextualTarget } from '../core/contextualTarget'
import type { DayData } from '../core/analysis'
import { Stepper } from '../components/Stepper'
import type { Order, OrderType, Supports, SupportKind } from '../core/types'
import { EMPTY_SUPPORTS } from '../core/types'

interface Props {
  open: boolean
  order?: Order
  /** Total relevé par le compteur pendant la prépa, proposé par défaut. */
  counted: number
  historyDays: DayData[]
  manualRate: number
  onConfirm: (data: { colisActual: number; supports: Supports; orderType: OrderType }) => void
  /** Revient au prélèvement en annulant la transition vers le filmage. */
  onResumePicking?: () => void
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
 * S'affiche pendant le filmage : le chrono tourne déjà, la saisie ne crée donc
 * aucun trou dans la timeline et se fait pendant que les palettes sont sous les
 * yeux. « Reprendre la prépa » annule la transition vers le filmage tant que
 * rien n'a encore été validé dans cette feuille.
 */
export function OrderEndSheet({
  open,
  order,
  counted,
  historyDays,
  manualRate,
  onConfirm,
  onResumePicking,
}: Props) {
  const [supports, setSupports] = useState<Supports>({ ...EMPTY_SUPPORTS })
  const [colis, setColis] = useState('')
  const [editColis, setEditColis] = useState(false)
  const [orderType, setOrderType] = useState<OrderType>('normale')

  useEffect(() => {
    if (!open || !order) return
    // Le compteur fait foi s'il a servi, sinon on retombe sur l'annoncé.
    setColis(String(counted > 0 ? counted : order.colisPlanned))
    setOrderType(order.orderType)
    setSupports({ ...EMPTY_SUPPORTS })
    setEditColis(false)
  }, [open, order, counted])

  if (!order) return null

  const colisNum = Number(colis || 0)
  const totalSupports = Object.values(supports).reduce((a, b) => a + b, 0)
  const reference = order
    ? contextualTarget(
        historyDays,
        {
          orderType,
          colis: colisNum,
          linesCount: order.linesCount,
          supports: totalSupports > 0 ? supports : undefined,
        },
        manualRate,
      )
    : undefined

  return (
    <Sheet open={open} title="Fin de commande">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <button
          type="button"
          onClick={() => setEditColis((v) => !v)}
          className="rounded-2xl border-2 border-ink-600 bg-ink-800 p-3 text-left"
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Colis préparés · appuie pour corriger
          </div>
          <div className="tabular mt-1 text-4xl font-bold text-accent">{colisNum}</div>
          {colisNum !== order.colisPlanned && (
            <div className="mt-1 text-sm text-slate-500">
              annoncé : {order.colisPlanned}
            </div>
          )}
        </button>

        {editColis && <NumPad value={colis} onChange={setColis} />}

        <div>
          <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Supports utilisés
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
        </div>

        <div>
          <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Type de commande
          </div>
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
        </div>

        {reference && <TargetReference reference={reference} />}

        <BigButton
          label="Valider"
          sub={
            totalSupports > 0
              ? `${colisNum} colis · ${totalSupports} support${totalSupports > 1 ? 's' : ''}`
              : 'Aucun support saisi'
          }
          onClick={() => onConfirm({ colisActual: colisNum, supports, orderType })}
        />
        {onResumePicking && (
          <button
            type="button"
            onClick={onResumePicking}
            className="pressable rounded-xl bg-ink-700 py-3 font-semibold text-slate-300"
          >
            Reprendre la prépa
          </button>
        )}
      </div>
    </Sheet>
  )
}
