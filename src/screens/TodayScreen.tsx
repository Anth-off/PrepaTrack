import { useEffect, useMemo, useState } from 'react'
import { BigButton } from '../components/BigButton'
import { Chrono } from '../components/Chrono'
import { CounterPad } from '../components/CounterPad'
import { PaceGauge } from '../components/PaceGauge'
import { QuickActions } from '../components/QuickActions'
import { RateCards } from '../components/RateCards'
import { TimeBreakdown } from '../components/TimeBreakdown'
import { contextualTarget } from '../core/contextualTarget'
import { breaksTaken, primaryActionLabel } from '../core/machine'
import { computeLive, isRateMeaningful, phaseElapsed } from '../core/metrics'
import { segmentDef } from '../core/segments'
import { formatShort, hhmm } from '../core/time'
import type { OrderType, SegmentType, Supports, SupportKind } from '../core/types'
import type { Session } from '../hooks/useSession'
import { useRecentDays } from '../hooks/useRecentDays'
import {
  addColis,
  advanceOrder,
  createStockShortage,
  endBriefing,
  endInterruption,
  finishDay,
  saveOrderResult,
  selectOrderPallet,
  shortageTotal,
  startCleanup,
  startDay,
  startInterruption,
  startOrder,
  toggleOvertime,
  unexplainedColis,
} from '../db/repo'
import {
  clearUndoCheckpoint,
  getUndoNotice,
  performUndoable,
  performWithoutUndo,
  undoLastAction,
  type UndoNotice,
} from '../db/undo'
import { NewOrderSheet } from './NewOrderSheet'
import { OrderEndSheet } from './OrderEndSheet'

interface Props {
  session: Session
  onShowReport: () => void
  /** Présentation bureau : deux colonnes, le suivi du jour à côté de l'action. */
  desktop?: boolean
}

/**
 * Écran de la vacation : il change de contenu selon la phase plutôt que de
 * faire naviguer entre plusieurs pages. Le geste à faire est toujours au même
 * endroit, quel que soit l'état.
 *
 * Sur grand écran, la colonne d'action garde sa largeur de téléphone — des
 * boutons de deux mètres de large n'aideraient personne — et la place gagnée
 * sert à afficher le bilan du jour en continu.
 */
export function TodayScreen({ session, onShowReport, desktop }: Props) {
  const { view, snap, day, live: sessionLive, shortages, settings, now } = session
  const { days: historyDays } = useRecentDays(365)
  const [newOrder, setNewOrder] = useState(false)
  const [orderEnd, setOrderEnd] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [confirmIncomplete, setConfirmIncomplete] = useState(false)
  const [undoNotice, setUndoNotice] = useState<UndoNotice>()

  useEffect(() => {
    let mounted = true
    void getUndoNotice().then((notice) => {
      if (mounted) setUndoNotice(notice)
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!undoNotice) return
    const delay = Math.max(0, undoNotice.expiresAt - Date.now())
    const timer = window.setTimeout(() => setUndoNotice(undefined), delay)
    return () => window.clearTimeout(timer)
  }, [undoNotice])

  async function runUndoable(label: string, action: () => Promise<unknown>) {
    const notice = await performUndoable(label, action)
    setUndoNotice(notice)
  }

  async function runWithoutUndo(action: () => Promise<unknown>) {
    setUndoNotice(undefined)
    return performWithoutUndo(action)
  }

  async function handleUndo() {
    const undone = await undoLastAction()
    setUndoNotice(undefined)
    return undone
  }

  const active = view.active
  const def = active ? segmentDef(active.type) : undefined
  const reference = useMemo(
    () =>
      contextualTarget(
        historyDays,
        {
          orderType: view.order?.orderType ?? 'normale',
          colis: view.order?.colisPlanned ?? 0,
          linesCount: view.order?.linesCount ?? 0,
        },
        settings.targetRate,
      ),
    [historyDays, settings.targetRate, view.order],
  )
  const live = useMemo(
    () =>
      view.order?.status === 'open'
        ? computeLive(view.order, snap.segments, session.events, reference.rate, now)
        : sessionLive,
    [now, reference.rate, session.events, sessionLive, snap.segments, view.order],
  )

  // Une interruption s'affiche seule — c'est bien sa durée propre qui compte.
  // Une phase de commande, elle, cumule tous ses segments : reprendre après un
  // trajet ne doit pas donner l'impression de repartir de zéro.
  const chrono = useMemo(() => {
    if (!active) return undefined
    if (segmentDef(active.type).interruption) {
      return { since: active.startedAt, elapsed: now - active.startedAt, resumes: 0 }
    }
    const phase = phaseElapsed(snap.segments, active.type, active.orderId, now)
    const count = snap.segments.filter(
      (s) => s.type === active.type && s.orderId === active.orderId && !s.deletedAt,
    ).length
    return { ...phase, resumes: count - 1 }
  }, [active, snap.segments, now])

  async function handlePrimary() {
    switch (view.phase) {
      case 'no_day':
        return runWithoutUndo(() => startDay())
      case 'briefing':
        return runWithoutUndo(() => endBriefing())
      case 'poste_prep':
      case 'ready':
        setUndoNotice(undefined)
        void clearUndoCheckpoint()
        return setNewOrder(true)
      case 'order_setup':
        return runUndoable('Début de la prépa', () => advanceOrder())
      case 'picking': {
        // Clore une commande dont le compte ne tombe pas juste est presque
        // toujours un oubli d'appui sur le compteur : on le signale avant, car
        // après la commande est close et le chiffre faux.
        const counted = live?.counted ?? 0
        const unexplained = view.order
          ? unexplainedColis(view.order.colisPlanned, counted, shortages, view.order.id)
          : 0
        if (counted > 0 && unexplained > 0 && !confirmIncomplete) {
          return setConfirmIncomplete(true)
        }
        setConfirmIncomplete(false)
        // Le filmage démarre immédiatement ; la saisie des supports se fait
        // par-dessus, chrono en marche, donc sans trou dans la timeline.
        await runUndoable('Fin de la prépa', () => advanceOrder())
        return setOrderEnd(true)
      }
      case 'wrapping':
        return runUndoable('Fin du filmage', () => advanceOrder())
      case 'docking':
        return runUndoable('Fin de la mise à quai', () => advanceOrder())
      case 'cleanup':
        return runWithoutUndo(() => finishDay())
      case 'interrupted':
        return runUndoable(`Fin — ${segmentDef(view.active!.type).label}`, () =>
          endInterruption(),
        )
    }
  }

  async function handleNewOrder(input: {
    colisPlanned: number
    linesCount: number
    orderType: OrderType
    storeCount: 1 | 2
    initialPallets: [number, number]
  }) {
    setNewOrder(false)
    await runWithoutUndo(() => startOrder(input))
  }

  async function handleOrderEnd(data: {
    colisActual: number
    supports: Supports
    orderType: OrderType
    palletSupports: Array<{ id: string; support?: SupportKind }>
    additionalPallets: Array<{ storeNumber: 1 | 2; support?: SupportKind }>
  }) {
    if (view.order) await runWithoutUndo(() => saveOrderResult(view.order!.id, data))
    setOrderEnd(false)
  }

  // Le compteur ne concerne que le prélèvement. Une fois la prépa terminée
  // (filmage, quai), ou pendant une interruption survenue à ce moment-là,
  // afficher un objectif de colis n'aurait plus aucun sens.
  const showCounter = view.inOrder && view.basePhase === 'picking'
  const orderPallets = useMemo(
    () => view.order ? (snap.pallets ?? []).filter((p) => p.orderId === view.order!.id) : [],
    [snap.pallets, view.order],
  )
  const openPallets = orderPallets.filter((p) => p.endedAt === undefined)

  const currentState = (
    <>
      {view.phase === 'no_day' ? (
        <IdleDay />
      ) : (
        <>
          {active && def && chrono && (
            <div
              className={
                showCounter && !desktop
                  ? 'card px-3 py-1.5'
                  : showCounter
                    ? 'card py-3'
                    : 'card'
              }
            >
              <Chrono
                since={chrono.since}
                elapsed={chrono.elapsed}
                resumes={chrono.resumes}
                label={def.label}
                emoji={def.emoji}
                // Pendant le prélèvement, c'est l'avance/retard qui prime : le
                // chrono cède la place plutôt que de forcer à faire défiler.
                small={showCounter}
              />
              {view.phase === 'interrupted' && view.resuming && (
                <p className="mt-2 text-center text-sm text-slate-400">
                  Reprise sur « {segmentDef(view.resuming).label} » à la fermeture
                </p>
              )}
              {view.order && view.phase !== 'interrupted' && (
                <p className="mt-2 text-center text-sm text-slate-400">
                  Commande {view.order.colisPlanned} colis · {view.order.linesCount || '?'}{' '}
                  ligne{view.order.linesCount > 1 ? 's' : ''} · {view.order.orderType}
                </p>
              )}
            </div>
          )}

          {live && showCounter && (
            <PaceGauge live={live} reference={reference} compact={!desktop} />
          )}
        </>
      )}
    </>
  )

  const controls = (
    <div className={`flex flex-col ${desktop ? 'gap-3' : 'gap-2'}`}>
      {undoNotice && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-ink-700 px-3 py-2"
        >
          <span className="min-w-0 truncate text-sm text-slate-300">
            {undoNotice.label}
          </span>
          <button
            type="button"
            onClick={() => void handleUndo()}
            className="pressable min-h-[2.75rem] shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-bold text-black"
          >
            Annuler
          </button>
        </div>
      )}
      {/* Le compteur voyage avec les contrôles, hors de la zone défilante : sur
          un petit écran il se retrouverait sinon sous la ligne de flottaison,
          alors que c'est le geste le plus répété de la vacation. */}
      {showCounter && (
        view.order && openPallets.length > 1 && (
          <div className="grid grid-cols-2 gap-2" aria-label="Palette active">
            {openPallets.sort((a, b) => a.storeNumber - b.storeNumber).map((pallet) => (
              <button
                key={pallet.id}
                type="button"
                onClick={() => void runWithoutUndo(() => selectOrderPallet(view.order!.id, pallet.id))}
                className={`pressable min-h-[2.75rem] rounded-xl px-2 text-sm font-bold ${
                  view.order!.activePalletId === pallet.id
                    ? 'bg-info text-black'
                    : 'bg-ink-700 text-slate-300'
                }`}
              >
                Magasin {pallet.storeNumber} · Palette {pallet.number}
              </button>
            ))}
          </div>
        )
      )}
      {showCounter && (
        <CounterPad
          counted={live?.counted ?? 0}
          sound={settings.soundAlerts}
          compact={!desktop}
          onAdd={(delta) =>
            void runUndoable(
              `${delta > 0 ? '+' : ''}${delta} colis`,
              () => addColis(delta),
            )
          }
        />
      )}

      {showCounter && view.order && (
        <button
          type="button"
          onClick={() =>
            void runUndoable('1 colis hors stock', () =>
              createStockShortage({ quantity: 1 }),
            )
          }
          className={`pressable rounded-xl border border-warn/50 bg-warn/10 px-4 font-bold text-warn ${
            desktop ? 'min-h-touch py-2' : 'min-h-[2.75rem] py-1.5'
          }`}
        >
          📦 +1 hors stock
          {shortageTotal(shortages, view.order.id) > 0 && (
            <span className="ml-2 text-sm">
              · total {shortageTotal(shortages, view.order.id)}
            </span>
          )}
        </button>
      )}

      <BigButton
        label={primaryActionLabel(view)}
        tone={view.phase === 'interrupted' ? 'ok' : 'accent'}
        onClick={handlePrimary}
        compact={!desktop}
      />

      {view.phase !== 'no_day' && view.phase !== 'cleanup' && (
        <div className="flex gap-2">
          <SmallButton
            label={snap.workday?.overtimeStartedAt ? '⏱ Heures supp ✓' : '⏱ Heures supp'}
            active={Boolean(snap.workday?.overtimeStartedAt)}
            onClick={() => void runWithoutUndo(() => toggleOvertime())}
          />
          <SmallButton label="🏁 Fin de journée" onClick={() => setConfirmEnd(true)} />
        </div>
      )}
    </div>
  )

  const quickBar =
    view.phase !== 'no_day' ? (
      <QuickActions
        view={view}
        settings={settings}
        breaksTaken={breaksTaken(snap)}
        onTrigger={(type: SegmentType) =>
          void runUndoable(
            view.active?.type === type
              ? `Fin — ${segmentDef(type).label}`
              : segmentDef(type).label,
            () => startInterruption(type),
          )
        }
        compact={!desktop}
      />
    ) : null

  const sheets = (
    <>
      <NewOrderSheet
        open={newOrder}
        historyDays={historyDays}
        manualRate={settings.targetRate}
        onCancel={() => setNewOrder(false)}
        onConfirm={handleNewOrder}
      />
      <OrderEndSheet
        open={orderEnd}
        order={view.order}
        pallets={orderPallets}
        counted={live?.counted ?? 0}
        historyDays={historyDays}
        manualRate={settings.targetRate}
        onConfirm={handleOrderEnd}
        onResumePicking={
          undoNotice
            ? async () => {
                if (await handleUndo()) setOrderEnd(false)
              }
            : undefined
        }
      />
      {confirmIncomplete && view.order && (
        <ConfirmDialog
          title="Le compte ne tombe pas juste"
          message={`Tu as compté ${live?.counted ?? 0} colis sur les ${view.order.colisPlanned} annoncés${shortageTotal(shortages, view.order.id) > 0 ? `, dont ${shortageTotal(shortages, view.order.id)} signalé(s) en rupture` : ''}. Il reste ${unexplainedColis(view.order.colisPlanned, live?.counted ?? 0, shortages, view.order.id)} colis sans explication. Si tu as oublié d'appuyer sur le compteur, ferme cette fenêtre et rattrape le compte.`}
          confirmLabel="C'est normal, terminer"
          onCancel={() => setConfirmIncomplete(false)}
          onConfirm={async () => {
            setConfirmIncomplete(false)
            await runUndoable('Fin de la prépa', () => advanceOrder())
            setOrderEnd(true)
          }}
        />
      )}

      {confirmEnd && (
        <ConfirmDialog
          title="Terminer la journée ?"
          message={
            view.inOrder
              ? 'Une commande est encore en cours : elle sera clôturée en l’état. Le rangement démarre ensuite.'
              : 'Le chrono de rangement / nettoyage démarre. Tu pourras clôturer juste après.'
          }
          confirmLabel="Oui, rangement"
          onCancel={() => setConfirmEnd(false)}
          onConfirm={async () => {
            setConfirmEnd(false)
            await runWithoutUndo(() => startCleanup())
          }}
        />
      )}
    </>
  )

  if (desktop) {
    return (
      <div className="grid flex-1 items-start gap-6 p-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {currentState}
          {controls}
          {quickBar && <div className="rounded-2xl border border-ink-600">{quickBar}</div>}
        </div>

        <DayPanel session={session} onShowReport={onShowReport} />
        {sheets}
      </div>
    )
  }

  return (
    // Journée occupe exactement la place laissée par la coque et la navigation.
    // Son contenu opérationnel se compacte au lieu de créer une zone défilante.
    <div data-testid="today-screen" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {/* Pendant le prélèvement, les totaux de la journée cèdent la place : ce
          qu'on regarde à cet instant c'est l'avance/retard, et sur un téléphone
          à encoche chaque bloc gagné évite un défilement. */}
      {!showCounter && <DayHeader session={session} onShowReport={onShowReport} />}
      {/* Pas de `flex-1` sur cette zone : un élément flexible ne se réduit pas
          en dessous de son contenu, et la barre d'actions qui suit déborderait
          alors de la fenêtre. C'est `mt-auto` sur les contrôles qui les pousse
          en bas quand il reste de la place, sans jamais forcer de hauteur. */}
      <div className="flex min-h-0 flex-col gap-2 px-4 pb-0.5">{currentState}</div>
      <div className="mt-auto shrink-0 px-4 pb-1 pt-1">{controls}</div>
      {quickBar}
      {sheets}
      {view.phase === 'cleanup' && (
        <div className="px-4 pb-4">
          <p className="text-center text-sm text-slate-400">
            Journée démarrée à {hhmm(day.startedAt)} · {formatShort(day.presence)} de présence
          </p>
        </div>
      )}
    </div>
  )
}

/** Colonne de droite sur PC : le bilan de la vacation, mis à jour en continu. */
function DayPanel({ session, onShowReport }: { session: Session; onShowReport: () => void }) {
  const { day, settings, view } = session

  if (view.phase === 'no_day' && day.ordersCount === 0) {
    return (
      <div className="card text-sm text-slate-500">
        Le suivi de la vacation apparaîtra ici dès que la journée sera lancée.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold">Vacation en cours</h2>
        <button
          type="button"
          onClick={onShowReport}
          className="pressable text-sm font-semibold text-accent"
        >
          Voir le détail ›
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Kpi label="Colis" value={String(day.colis)} />
        <Kpi label="Commandes" value={String(day.ordersCount)} />
        <Kpi label="Présence" value={formatShort(day.presence)} />
        <Kpi label="Perdu" value={formatShort(day.wasteTime)} />
      </div>

      <RateCards day={day} targetRate={settings.targetRate} />
      <TimeBreakdown day={day} />

      {day.orders.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Commandes du jour
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {day.orders.map((m, i) => {
              const shown = m.rateOrder > 0 && isRateMeaningful(m.totalWorked)
              return (
                <li key={m.order.id} className="flex items-baseline justify-between text-sm">
                  <span className="truncate">
                    #{i + 1} · {m.colis} colis
                    <span className="ml-2 capitalize text-slate-600">{m.order.orderType}</span>
                  </span>
                  <span className="tabular shrink-0 font-bold">
                    {shown ? `${Math.round(m.rateOrder)}/h` : '—'}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function DayHeader({ session, onShowReport }: { session: Session; onShowReport: () => void }) {
  const { day, view } = session
  if (view.phase === 'no_day' && day.colis === 0) return null
  const rateShown = day.rates.day > 0 && isRateMeaningful(day.worked)

  return (
    <button type="button" onClick={onShowReport} className="w-full px-4 pb-3 pt-2 text-left">
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-ink-800 px-4 py-3">
        <Stat label="Colis" value={String(day.colis)} />
        <Stat
          label="Cadence jour"
          value={rateShown ? `${Math.round(day.rates.day)}` : '—'}
          unit={rateShown ? '/h' : undefined}
          tone={
            rateShown ? (day.rates.day >= session.settings.targetRate ? 'ok' : 'warn') : undefined
          }
        />
        <Stat label="Commandes" value={String(day.ordersCount)} />
        <span className="text-slate-500">›</span>
      </div>
    </button>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="card px-3 py-2">
      <div className="text-[0.6rem] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="tabular text-xl font-bold">{value}</div>
    </div>
  )
}

function Stat({
  label,
  value,
  unit,
  tone,
}: {
  label: string
  value: string
  unit?: string
  tone?: 'ok' | 'warn'
}) {
  return (
    <div>
      <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`tabular text-xl font-bold ${
          tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-slate-100'
        }`}
      >
        {value}
        {unit && <span className="text-sm font-semibold text-slate-500">{unit}</span>}
      </div>
    </div>
  )
}

function IdleDay() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <div className="text-6xl">📦</div>
      <h1 className="text-2xl font-bold">PrepaTrack</h1>
      <p className="max-w-xs text-slate-400">
        Lance le briefing pour démarrer le suivi. Tout est enregistré en local, même sans
        réseau.
      </p>
    </div>
  )
}


function SmallButton({
  label,
  onClick,
  active,
}: {
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pressable flex-1 rounded-xl px-3 py-3 text-sm font-semibold ${
        active ? 'bg-info/20 text-info' : 'bg-ink-700 text-slate-300'
      }`}
    >
      {label}
    </button>
  )
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 md:items-center">
      <div className="w-full max-w-md rounded-2xl border border-ink-600 bg-ink-800 p-5">
        <h3 className="text-xl font-bold">{title}</h3>
        <p className="mt-2 text-slate-400">{message}</p>
        <div className="mt-5 flex flex-col gap-2">
          <BigButton label={confirmLabel} onClick={onConfirm} />
          <button
            type="button"
            onClick={onCancel}
            className="pressable rounded-xl bg-ink-700 py-3 font-semibold text-slate-300"
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  )
}
