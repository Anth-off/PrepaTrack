import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { IntegrityPanel } from '../components/IntegrityPanel'
import { RateCards } from '../components/RateCards'
import { RecoList } from '../components/RecoList'
import { recommend } from '../core/recommendations'
import { inspectIntegrity, type IntegrityIssue } from '../core/integrity'
import { TimeBreakdown } from '../components/TimeBreakdown'
import { Timeline } from '../components/Timeline'
import { isRateMeaningful, type OrderMetrics } from '../core/metrics'
import { ESTIMATED_MISSING_HELP, ESTIMATED_MISSING_LABEL } from '../core/metricLabels'
import { formatDayLabel, formatShort, hhmm } from '../core/time'
import type { OrderPallet, StockShortage, SupportKind } from '../core/types'
import {
  deleteOrderPallet,
  deleteStockShortage,
  deleteWorkday,
  reconcileWorkdayBounds,
  setStockShortageResolved,
  updateStockShortage,
  updateOrderPallet,
} from '../db/repo'
import {
  dismissIntegrityIssue,
  getIntegrityDismissals,
  visibleIntegrityIssues,
} from '../db/integrity'
import { useDay } from '../hooks/useDay'
import { useNow } from '../hooks/useNow'
import { CorrectSheet } from './CorrectSheet'
import { OrderEditSheet } from './OrderEditSheet'
import { StockShortageSheet } from './StockShortageSheet'
import { PalletEditSheet } from './PalletEditSheet'
import { RecordingArchive } from '../components/RecordingArchive'
import { deleteWorkdayRecordings } from '../db/recordings'
import type { Order, Segment } from '../core/types'

interface Props {
  workdayId: string
  initialSegmentId?: string
  onBack: () => void
}

const SUPPORT_SHORT: Record<SupportKind, string> = {
  europe: 'Eur',
  ipp: 'IPP',
  demi: '½',
  vmax: 'Vmax',
  vrac: 'Vrac',
  perdue: 'Perdue',
}

/** Bilan complet d'une journée : chiffres, répartition, commandes, tracé. */
export function DayReportScreen({ workdayId, initialSegmentId, onBack }: Props) {
  const now = useNow(15_000)
  const { snap, events, shortages, day, settings, targetRate, loading } = useDay(workdayId)
  const storedDismissals = useLiveQuery(() => getIntegrityDismissals(), [])
  const [editing, setEditing] = useState<Segment | undefined>()
  const [editingOrder, setEditingOrder] = useState<Order | undefined>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingShortage, setEditingShortage] = useState<StockShortage | undefined>()
  const [editingPallet, setEditingPallet] = useState<OrderPallet | undefined>()

  useEffect(() => {
    void reconcileWorkdayBounds(workdayId)
  }, [workdayId])

  useEffect(() => {
    if (!initialSegmentId || !snap) return
    setEditing(snap.segments.find((segment) => segment.id === initialSegmentId))
  }, [initialSegmentId, snap])

  // Les mêmes règles que le tableau de bord, appliquées à cette seule journée :
  // celles qui demandent un historique se taisent d'elles-mêmes.
  const recommendations = useMemo(() => {
    if (!snap?.workday || !day) return []
    return recommend({
      days: [
        {
          id: snap.workday.id,
          date: snap.workday.date,
          segments: snap.segments,
          events,
          metrics: day,
        },
      ],
      targetRate,
    })
  }, [snap, events, day, targetRate])

  const integrityIssues = useMemo(() => {
    if (!snap?.workday) return []
    return visibleIntegrityIssues(
      inspectIntegrity({ snap, events, shortages, settings, now }),
      storedDismissals ?? {},
    )
  }, [events, now, settings, shortages, snap, storedDismissals])

  function openIntegrityIssue(issue: IntegrityIssue) {
    if (!snap) return
    if (issue.entity === 'order') {
      setEditingOrder(snap.orders.find((order) => order.id === issue.entityId))
      return
    }
    if (issue.entity === 'segment') {
      setEditing(snap.segments.find((segment) => segment.id === issue.entityId))
      return
    }
    if (issue.entity === 'shortage') {
      setEditingShortage(shortages.find((shortage) => shortage.id === issue.entityId))
      return
    }
    document.getElementById('day-timeline')?.scrollIntoView({ behavior: 'smooth' })
  }

  if (loading) return <Placeholder text="Chargement…" onBack={onBack} />
  if (!snap || !day) return <Placeholder text="Aucune donnée pour ce jour." onBack={onBack} />
  const date = snap.workday!.date
  const planned = snap.orders.reduce((sum, order) => sum + order.colisPlanned, 0)
  const shortageQuantity = shortages.reduce((sum, shortage) => sum + shortage.quantity, 0)

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-1 flex-col overflow-x-hidden">
      <header className="sticky top-0 z-10 border-b border-ink-600 bg-ink-900/95 px-4 pb-3 pt-2 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          className="pressable text-sm font-semibold text-slate-400"
        >
          ‹ Retour
        </button>
        {/* `capitalize` mettrait une majuscule à chaque mot : « Jeudi 30 Juillet ». */}
        <h1 className="text-xl font-bold first-letter:uppercase">{formatDayLabel(date)}</h1>
        <p className="tabular text-sm text-slate-500">
          {hhmm(day.startedAt)}
          {day.endedAt ? ` → ${hhmm(day.endedAt)}` : ' → en cours'} ·{' '}
          {formatShort(day.presence)} de présence
        </p>
      </header>

      <div className="flex flex-col gap-4 px-4 py-4 md:px-6">
        <div className="grid grid-cols-3 gap-2">
          <Kpi label="Colis" value={String(day.colis)} />
          <Kpi label="Commandes" value={String(day.ordersCount)} />
          <Kpi
            label={ESTIMATED_MISSING_LABEL}
            value={String(Math.round(day.lostColis))}
            tone={day.lostColis > 30 ? 'bad' : undefined}
          />
        </div>

        <p className="-mt-2 text-xs leading-relaxed text-slate-500">
          <b className="text-slate-400">{ESTIMATED_MISSING_LABEL} :</b>{' '}
          {ESTIMATED_MISSING_HELP}
        </p>

        <IntegrityPanel
          issues={integrityIssues}
          onOpen={openIntegrityIssue}
          onDismiss={dismissIntegrityIssue}
        />

        <RateCards day={day} targetRate={targetRate} />

        <section className="card">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Colis de la journée
          </h3>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <Mini label="Prévus" value={String(planned)} />
            <Mini label="Préparés" value={String(day.colis)} />
            <Mini label="En rupture" value={String(shortageQuantity)} />
          </div>
        </section>

        {day.overtime > 0 && (
          <div className="card flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-400">
              ⏱ Heures supplémentaires
            </span>
            <span className="tabular text-xl font-bold text-info">
              {formatShort(day.overtime)}
            </span>
          </div>
        )}

        <TimeBreakdown day={day} />

        <RecoList recommendations={recommendations} dayCount={1} />

        {day.orders.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Commandes
            </h3>
            <div className="flex flex-col gap-2">
              {day.orders.map((m, i) => (
                <OrderCard
                  key={m.order.id}
                  index={i + 1}
                  m={m}
                  targetRate={targetRate}
                  onEdit={() => setEditingOrder(m.order)}
                  onEditPallet={setEditingPallet}
                />
              ))}
            </div>
          </section>
        )}

        {shortages.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Ruptures de stock
            </h3>
            <div className="flex flex-col gap-2">
              {shortages.map((shortage) => {
                const orderIndex = snap.orders.findIndex((order) => order.id === shortage.orderId)
                return (
                  <button
                    key={shortage.id}
                    type="button"
                    onClick={() => setEditingShortage(shortage)}
                    className="card pressable text-left"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-bold text-warn">
                        📦 {shortage.quantity} colis · commande #{orderIndex + 1}
                      </span>
                      <span className={shortage.resolved ? 'text-ok' : 'text-warn'}>
                        {shortage.resolved ? 'Résolue' : 'À traiter'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">{hhmm(shortage.at)} · modifier</p>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        <section id="day-timeline">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Tracé de la journée
            </h3>
            <span className="text-xs text-slate-500">appuie pour corriger</span>
          </div>
          <Timeline segments={snap.segments} now={now} onSelect={setEditing} />
        </section>

        <RecordingArchive workdayId={workdayId} />

        <section className="border-t border-ink-600 pt-4">
          {confirmDelete ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-slate-300">
                Supprimer cette journée et tout ce qu'elle contient : {day.ordersCount}{' '}
                commande{day.ordersCount > 1 ? 's' : ''}, {day.colis} colis et l'ensemble
                des chronos. Si la synchro est active, la suppression est aussi répercutée
                sur l'autre appareil.
              </p>
              <button
                type="button"
                onClick={async () => {
                  await deleteWorkday(workdayId)
                  await deleteWorkdayRecordings(workdayId)
                  onBack()
                }}
                className="pressable min-h-touch rounded-xl bg-bad font-bold text-white"
              >
                Oui, supprimer définitivement
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="pressable rounded-xl bg-ink-700 py-3 font-semibold text-slate-300"
              >
                Annuler
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="pressable w-full rounded-xl border border-bad/40 py-3 text-sm font-semibold text-bad"
            >
              Supprimer cette journée
            </button>
          )}
        </section>
      </div>

      <CorrectSheet segment={editing} onClose={() => setEditing(undefined)} />
      <OrderEditSheet order={editingOrder} onClose={() => setEditingOrder(undefined)} />
      <PalletEditSheet
        pallet={editingPallet}
        onClose={() => setEditingPallet(undefined)}
        onSave={(patch) => updateOrderPallet(editingPallet!.id, patch)}
        onDelete={async () => {
          if (editingPallet) await deleteOrderPallet(editingPallet.id)
        }}
      />
      <StockShortageSheet
        shortage={editingShortage}
        onClose={() => setEditingShortage(undefined)}
        onSave={async (input) => {
          if (editingShortage) await updateStockShortage(editingShortage.id, input)
        }}
        onSetResolved={async (resolved) => {
          if (editingShortage) await setStockShortageResolved(editingShortage.id, resolved)
        }}
        onDelete={async () => {
          if (editingShortage) await deleteStockShortage(editingShortage.id)
        }}
      />
    </div>
  )
}

function OrderCard({
  index,
  m,
  targetRate,
  onEdit,
  onEditPallet,
}: {
  index: number
  m: OrderMetrics
  targetRate: number
  onEdit: () => void
  onEditPallet: (pallet: OrderPallet) => void
}) {
  const shown = m.rateOrder > 0 && isRateMeaningful(m.totalWorked)
  const ratio = targetRate > 0 ? m.rateOrder / targetRate : 0
  const tone = !shown
    ? 'text-slate-600'
    : ratio >= 1
      ? 'text-ok'
      : ratio >= 0.9
        ? 'text-warn'
        : 'text-bad'
  const supports = (Object.entries(m.order.supports) as [SupportKind, number][]).filter(
    ([, n]) => n > 0,
  )

  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <button
          type="button"
          onClick={onEdit}
          className="pressable text-left font-bold"
          title="Corriger cette commande"
        >
          #{index} · {m.colis} colis
          <span className="ml-2 text-sm font-medium capitalize text-slate-500">
            {m.order.orderType}
          </span>
          <span className="ml-2 text-xs font-normal text-slate-600">modifier</span>
        </button>
        <span className={`tabular text-xl font-bold ${tone}`}>
          {shown ? Math.round(m.rateOrder) : '—'}
          {shown && <span className="text-sm text-slate-500">/h</span>}
        </span>
      </div>

      <div className="tabular mt-1 text-sm text-slate-500">
        {hhmm(m.order.startedAt)}
        {m.order.endedAt ? ` → ${hhmm(m.order.endedAt)}` : ''} · {formatShort(m.totalWorked)}
        {m.order.linesCount > 0 &&
          ` · ${m.order.linesCount} ligne${m.order.linesCount > 1 ? 's' : ''}`}
        {m.colisPerLine > 0 && ` (${m.colisPerLine.toFixed(1)} colis/ligne)`}
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
        <Mini label="Palette" value={formatShort(m.setup)} />
        <Mini label="Prépa" value={formatShort(m.picking)} />
        <Mini label="Filmage" value={formatShort(m.wrapping)} />
        <Mini label="Quai" value={formatShort(m.docking)} />
      </div>

      {(m.interruptions > 0 || m.breaks > 0) && (
        <div className="mt-2 text-xs text-slate-500">
          {m.interruptions > 0 && `Interruptions ${formatShort(m.interruptions)}`}
          {m.interruptions > 0 && m.breaks > 0 && ' · '}
          {m.breaks > 0 && `Pauses ${formatShort(m.breaks)}`}
          {m.palletChanges > 0 && ` · ${m.palletChanges} changement(s) de palette`}
        </div>
      )}

      {supports.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {supports.map(([key, n]) => (
            <span key={key} className="rounded-md bg-ink-700 px-2 py-0.5 text-xs font-semibold">
              {n}× {SUPPORT_SHORT[key]}
            </span>
          ))}
        </div>
      )}

      {m.pallets.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-ink-600 pt-2">
          {m.pallets.map((palette) => (
            <button key={palette.pallet.id} type="button"
              onClick={() => onEditPallet(palette.pallet)}
              className="pressable flex items-center justify-between rounded-lg bg-ink-700 px-2 py-1.5 text-left text-xs">
              <span className="font-semibold">
                Magasin {palette.pallet.storeNumber} · Palette {palette.pallet.number}
                {palette.pallet.support ? ` · ${SUPPORT_SHORT[palette.pallet.support]}` : ''}
              </span>
              <span className="tabular text-slate-400">
                {palette.colis} colis · prépa {formatShort(palette.picking)} · filmage {formatShort(palette.wrapping)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-ink-700 py-1">
      <div className="text-[0.6rem] uppercase text-slate-500">{label}</div>
      <div className="tabular text-sm font-bold">{value}</div>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="card px-3 py-3">
      <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`tabular text-3xl font-bold ${tone === 'bad' ? 'text-bad' : ''}`}>
        {value}
      </div>
    </div>
  )
}

function Placeholder({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <div className="px-4 pt-2">
      <button
        type="button"
        onClick={onBack}
        className="pressable text-sm font-semibold text-slate-400"
      >
        ‹ Retour
      </button>
      <p className="mt-8 text-center text-slate-500">{text}</p>
    </div>
  )
}
