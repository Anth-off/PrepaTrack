import type { Table } from 'dexie'
import { db, uid } from './db'
import {
  activeSegment,
  canInterrupt,
  deriveView,
  isSuspendingSegment,
  nextOrderPhase,
  popStack,
  pushStack,
} from '../core/machine'
import type { Snapshot } from '../core/machine'
import { dayKey } from '../core/time'
import { currentOwnerId, ownedByCurrent } from '../sync/profile'
import type {
  ColisEvent,
  Order,
  OrderPallet,
  OrderType,
  Segment,
  SegmentType,
  StockShortage,
  SuspendedRef,
  Supports,
  Workday,
} from '../core/types'
import { EMPTY_SUPPORTS } from '../core/types'
import { scheduleDurableBackup } from '../native/durableStorage'

/**
 * Toutes les écritures passent par ici. Chaque transition ferme le segment
 * courant et ouvre le suivant AU MÊME INSTANT : la timeline reste continue,
 * sans trou ni chevauchement, ce qui rend la somme des durées exactement égale
 * au temps de présence.
 *
 * Le paramètre `at` permet de rejouer une vacation en test avec des horaires
 * arbitraires ; en usage réel il vaut toujours `Date.now()`.
 */

function stamp<T extends { updatedAt: number; syncState: 'pending' | 'synced'; ownerId?: string }>(
  o: T,
): T {
  o.updatedAt = Date.now()
  o.syncState = 'pending'
  // Posé une seule fois, à la création. Un gestionnaire qui corrige la journée
  // d'un préparateur ne doit pas se l'attribuer au passage.
  if (o.ownerId === undefined) o.ownerId = currentOwnerId()
  scheduleDurableBackup()
  return o
}

export async function loadSnapshot(): Promise<Snapshot> {
  // Une vacation supprimée — effacement manuel, ou suppression descendue de
  // l'autre appareil — garde son statut `open` : il faut l'écarter ici, sinon
  // l'app rouvrirait une journée que l'utilisateur croit effacée.
  //
  // Le filtre sur le propriétaire est tout aussi indispensable : un gestionnaire
  // reçoit les vacations de toute l'équipe, et sans lui il « reprendrait » la
  // journée en cours d'un préparateur au lieu de la sienne.
  const workday = await db.workdays
    .where('status')
    .equals('open')
    .filter((w) => !w.deletedAt && ownedByCurrent(w))
    .first()
  if (!workday) return { segments: [], orders: [] }
  return loadSnapshotFor(workday)
}

export async function loadSnapshotFor(workday: Workday): Promise<Snapshot> {
  const [segments, orders, pallets] = await Promise.all([
    db.segments.where('workdayId').equals(workday.id).toArray(),
    db.orders.where('workdayId').equals(workday.id).toArray(),
    db.orderPallets.where('workdayId').equals(workday.id).toArray(),
  ])
  return {
    workday,
    segments: segments.filter((s) => !s.deletedAt).sort((a, b) => a.startedAt - b.startedAt),
    orders: orders.filter((o) => !o.deletedAt).sort((a, b) => a.startedAt - b.startedAt),
    pallets: pallets
      .filter((p) => !p.deletedAt)
      .sort((a, b) => a.orderId.localeCompare(b.orderId) || a.number - b.number),
  }
}

async function orderCount(orderId: string, palletId?: string): Promise<number> {
  const events = await db.colisEvents.where('orderId').equals(orderId).toArray()
  return Math.max(0, events
    .filter((e) => !e.deletedAt && (palletId === undefined || e.palletId === palletId))
    .reduce((sum, e) => sum + e.delta, 0))
}

async function closePallet(palletId: string, at: number): Promise<void> {
  const current = await db.orderPallets.get(palletId)
  if (!current || current.deletedAt || current.endedAt !== undefined) return
  current.endedAt = Math.max(at, current.startedAt)
  current.endCount = await orderCount(current.orderId, current.id)
  await db.orderPallets.put(stamp(current))
}

async function closeOpenPallets(orderId: string, at: number): Promise<void> {
  const pallets = await db.orderPallets.where('orderId').equals(orderId).toArray()
  for (const pallet of pallets.filter((p) => !p.deletedAt && p.endedAt === undefined)) {
    await closePallet(pallet.id, at)
  }
}

async function reconcilePalletCounts(order: Order): Promise<void> {
  if (order.colisActual === undefined) return
  const pallets = (await db.orderPallets.where('orderId').equals(order.id).toArray())
    .filter((p) => !p.deletedAt)
    .sort((a, b) => a.number - b.number)
  let difference = Math.max(0, order.colisActual) - pallets.reduce(
    (sum, pallet) => sum + Math.max(0, (pallet.endCount ?? 0) - pallet.startCount),
    0,
  )
  for (const pallet of [...pallets].reverse()) {
    if (difference === 0) break
    const current = Math.max(0, (pallet.endCount ?? 0) - pallet.startCount)
    const change = difference > 0 ? difference : -Math.min(current, -difference)
    pallet.endCount = pallet.startCount + current + change
    difference -= change
    await db.orderPallets.put(stamp(pallet))
  }
}

export async function currentOrderPallet(orderId: string): Promise<OrderPallet | undefined> {
  const order = await db.orders.get(orderId)
  if (order?.activePalletId) {
    const active = await db.orderPallets.get(order.activePalletId)
    if (active && !active.deletedAt && active.endedAt === undefined) return active
  }
  const pallets = await db.orderPallets.where('orderId').equals(orderId).toArray()
  return pallets.filter((p) => !p.deletedAt && p.endedAt === undefined).sort((a, b) => a.number - b.number)[0]
}

export async function selectOrderPallet(
  orderId: string,
  palletId: string,
  at: number = Date.now(),
): Promise<void> {
  const [order, pallet] = await Promise.all([db.orders.get(orderId), db.orderPallets.get(palletId)])
  if (!order || !pallet || pallet.orderId !== orderId || pallet.endedAt !== undefined) return
  order.activePalletId = pallet.id
  await db.orders.put(stamp(order))
  const snap = await loadSnapshot()
  const active = activeSegment(snap)
  if (snap.workday && active?.orderId === orderId && active.palletId !== pallet.id) {
    await closeActive(at)
    await db.segments.put(newSegment(snap.workday.id, active.type, at, {
      orderId,
      palletId: pallet.id,
      stack: active.stack,
      note: active.note,
    }))
  }
}

/**
 * Charge une vacation par son identifiant. On ne l'adresse jamais par sa date :
 * rien n'interdit deux vacations le même jour (une clôturée trop tôt puis
 * relancée, une coupure), et la retrouver par date en afficherait toujours la
 * même des deux.
 */
export async function loadSnapshotById(id: string): Promise<Snapshot | undefined> {
  const workday = await db.workdays.get(id)
  if (!workday || workday.deletedAt) return undefined
  return loadSnapshotFor(workday)
}

function newSegment(
  workdayId: string,
  type: SegmentType,
  at: number,
  opts: { orderId?: string; palletId?: string; stack?: SuspendedRef[]; note?: string } = {},
): Segment {
  return stamp({
    id: uid(),
    workdayId,
    type,
    startedAt: at,
    orderId: opts.orderId,
    palletId: opts.palletId,
    stack: opts.stack && opts.stack.length > 0 ? opts.stack : undefined,
    note: opts.note,
    updatedAt: 0,
    syncState: 'pending',
  })
}

/** Ferme le segment ouvert, s'il y en a un, et le renvoie. */
async function closeActive(at: number): Promise<Segment | undefined> {
  const snap = await loadSnapshot()
  const active = activeSegment(snap)
  if (!active) return undefined
  // Un `at` antérieur au début produirait une durée négative : on borne.
  active.endedAt = Math.max(at, active.startedAt)
  await db.segments.put(stamp(active))
  return active
}

// --- Journée ---------------------------------------------------------------

export async function startDay(at: number = Date.now()): Promise<Workday> {
  const existing = await db.workdays.where('status').equals('open').first()
  if (existing) return existing

  const workday: Workday = stamp({
    id: uid(),
    date: dayKey(at),
    status: 'open',
    startedAt: at,
    updatedAt: 0,
    syncState: 'pending',
  })
  await db.workdays.put(workday)
  await db.segments.put(newSegment(workday.id, 'briefing', at))
  return workday
}

/** Fin du briefing : bascule automatiquement sur la prépa du poste. */
export async function endBriefing(at: number = Date.now()): Promise<void> {
  const closed = await closeActive(at)
  if (!closed) return
  await db.segments.put(newSegment(closed.workdayId, 'poste_prep', at))
}

export async function startCleanup(at: number = Date.now()): Promise<void> {
  const snap = await loadSnapshot()
  if (!snap.workday) return
  // Une commande encore ouverte est clôturée en l'état plutôt que laissée
  // pendante : mieux vaut une commande incomplète qu'une journée incohérente.
  const open = snap.orders.find((o) => o.status === 'open')
  if (open) {
    open.status = 'done'
    open.endedAt = at
    await db.orders.put(stamp(open))
    await closeOpenPallets(open.id, at)
    await reconcilePalletCounts(open)
  }
  await closeActive(at)
  await db.segments.put(newSegment(snap.workday.id, 'cleanup', at))
}

export async function finishDay(at: number = Date.now()): Promise<void> {
  const snap = await loadSnapshot()
  if (!snap.workday) return
  await closeActive(at)
  snap.workday.status = 'closed'
  snap.workday.endedAt = at
  await db.workdays.put(stamp(snap.workday))
}

/**
 * Heure de fin plausible pour une vacation restée ouverte.
 *
 * Renvoie la fin du dernier segment réellement terminé. Clôturer à l'heure
 * actuelle donnerait une journée de quarante heures si l'oubli date de la
 * veille, et fausserait durablement les moyennes.
 */
export async function plausibleEndFor(workdayId: string): Promise<number | undefined> {
  const segments = await db.segments.where('workdayId').equals(workdayId).toArray()
  const ends = segments
    .filter((s) => !s.deletedAt && s.endedAt !== undefined)
    .map((s) => s.endedAt!)
  return ends.length > 0 ? Math.max(...ends) : undefined
}

/**
 * Clôt une vacation précise, y compris celle d'un autre compte.
 *
 * `finishDay()` ne convient pas ici : il agit sur la vacation active du compte
 * courant, alors qu'un gestionnaire doit pouvoir réparer celle d'un préparateur.
 */
export async function closeWorkdayAt(workdayId: string, at: number): Promise<void> {
  const workday = await db.workdays.get(workdayId)
  if (!workday || workday.deletedAt) return

  const segments = (await db.segments.where('workdayId').equals(workdayId).toArray()).filter(
    (s) => !s.deletedAt,
  )

  // Jamais avant le début du dernier segment : une durée négative corromprait
  // toutes les cadences de la journée.
  const lastStart = segments.reduce((max, s) => Math.max(max, s.startedAt), workday.startedAt)
  const end = Math.max(at, lastStart)

  for (const segment of segments) {
    if (segment.endedAt === undefined) {
      segment.endedAt = end
      segment.editedAt = Date.now()
      await db.segments.put(stamp(segment))
    }
  }

  const orders = (await db.orders.where('workdayId').equals(workdayId).toArray()).filter(
    (o) => !o.deletedAt && o.status === 'open',
  )
  for (const order of orders) {
    order.status = 'done'
    order.endedAt = end
    await db.orders.put(stamp(order))
    await closeOpenPallets(order.id, end)
    await reconcilePalletCounts(order)
  }

  workday.status = 'closed'
  workday.endedAt = end
  await db.workdays.put(stamp(workday))
  await reconcileWorkdayBounds(workdayId)
}

/**
 * Répercute une correction de chronologie sur les bornes récapitulatives.
 *
 * Les métriques utilisent surtout les segments, mais les en-têtes de journée,
 * commandes et palettes possèdent aussi leurs propres bornes. Les laisser
 * inchangées après une correction affichait plusieurs durées contradictoires.
 */
export async function reconcileWorkdayBounds(workdayId: string): Promise<void> {
  const [workday, rawSegments, orders, pallets] = await Promise.all([
    db.workdays.get(workdayId),
    db.segments.where('workdayId').equals(workdayId).toArray(),
    db.orders.where('workdayId').equals(workdayId).toArray(),
    db.orderPallets.where('workdayId').equals(workdayId).toArray(),
  ])
  if (!workday || workday.deletedAt) return
  const segments = rawSegments.filter((row) => !row.deletedAt)
  const bounds = (rows: Segment[]) => {
    if (rows.length === 0) return undefined
    const startedAt = Math.min(...rows.map((row) => row.startedAt))
    const open = rows.some((row) => row.endedAt === undefined)
    const ended = rows.flatMap((row) => row.endedAt === undefined ? [] : [row.endedAt])
    return { startedAt, open, endedAt: ended.length > 0 ? Math.max(...ended) : undefined }
  }

  for (const order of orders.filter((row) => !row.deletedAt)) {
    const orderBounds = bounds(segments.filter((row) => row.orderId === order.id))
    if (!orderBounds) continue
    let changed = false
    if (order.startedAt !== orderBounds.startedAt) {
      order.startedAt = orderBounds.startedAt
      changed = true
    }
    if (order.status === 'done' && !orderBounds.open && orderBounds.endedAt !== undefined && order.endedAt !== orderBounds.endedAt) {
      order.endedAt = orderBounds.endedAt
      changed = true
    }
    if (changed) await db.orders.put(stamp(order))
  }

  for (const pallet of pallets.filter((row) => !row.deletedAt)) {
    const palletBounds = bounds(segments.filter((row) => row.palletId === pallet.id))
    if (!palletBounds) continue
    let changed = false
    if (pallet.startedAt !== palletBounds.startedAt) {
      pallet.startedAt = palletBounds.startedAt
      changed = true
    }
    if (pallet.endedAt !== undefined && !palletBounds.open && palletBounds.endedAt !== undefined && pallet.endedAt !== palletBounds.endedAt) {
      pallet.endedAt = palletBounds.endedAt
      changed = true
    }
    if (changed) await db.orderPallets.put(stamp(pallet))
  }

  const dayBounds = bounds(segments)
  if (!dayBounds) return
  let changed = false
  if (workday.startedAt !== dayBounds.startedAt) {
    workday.startedAt = dayBounds.startedAt
    changed = true
  }
  if (workday.status === 'closed' && !dayBounds.open && dayBounds.endedAt !== undefined && workday.endedAt !== dayBounds.endedAt) {
    workday.endedAt = dayBounds.endedAt
    changed = true
  }
  if (changed) await db.workdays.put(stamp(workday))
}

/** Marque le début (ou annule le marquage) des heures supplémentaires. */
export async function toggleOvertime(at: number = Date.now()): Promise<void> {
  const snap = await loadSnapshot()
  if (!snap.workday) return
  snap.workday.overtimeStartedAt = snap.workday.overtimeStartedAt ? undefined : at
  await db.workdays.put(stamp(snap.workday))
}

// --- Commandes -------------------------------------------------------------

export interface NewOrderInput {
  colisPlanned: number
  linesCount: number
  orderType: OrderType
  storeCount?: 1 | 2
  /** Nombre total choisi par l'interface simplifiée. */
  initialPalletCount?: number
}

export async function startOrder(
  input: NewOrderInput,
  at: number = Date.now(),
): Promise<Order | undefined> {
  const snap = await loadSnapshot()
  if (!snap.workday) return undefined

  const storeCount = input.storeCount ?? 1
  const initialPalletCount = Math.max(
    storeCount,
    Math.trunc(input.initialPalletCount ?? storeCount),
  )
  const palletSpecs = Array.from({ length: initialPalletCount }, (_, index) => ({
    id: uid(),
    storeNumber: (storeCount === 1 ? 1 : (index % 2) + 1) as 1 | 2,
  }))
  const order: Order = stamp({
    id: uid(),
    workdayId: snap.workday.id,
    status: 'open',
    orderType: input.orderType,
    colisPlanned: input.colisPlanned,
    linesCount: input.linesCount,
    supports: { ...EMPTY_SUPPORTS },
    storeCount,
    activePalletId: palletSpecs[0].id,
    startedAt: at,
    updatedAt: 0,
    syncState: 'pending',
  })
  await db.orders.put(order)
  await db.orderPallets.bulkPut(palletSpecs.map((spec, index) => stamp({
    id: spec.id, workdayId: order.workdayId, orderId: order.id, number: index + 1,
    storeNumber: spec.storeNumber, startedAt: at, startCount: 0,
    updatedAt: 0, syncState: 'pending',
  })))

  await closeActive(at)
  await db.segments.put(newSegment(snap.workday.id, 'order_setup', at, {
    orderId: order.id,
    palletId: order.activePalletId,
  }))
  return order
}

/**
 * Avance d'une phase de commande : setup → prépa → filmage → mise à quai.
 * Depuis la mise à quai, clôt la commande et repasse en attente.
 */
export async function advanceOrder(at: number = Date.now()): Promise<void> {
  const snap = await loadSnapshot()
  const view = deriveView(snap)
  if (!snap.workday || !view.active) return

  const current = view.active.type
  const orderId = view.active.orderId

  if (current === 'docking') {
    await closeActive(at)
    if (orderId) {
      const order = await db.orders.get(orderId)
      if (order) {
        order.status = 'done'
        order.endedAt = at
        await db.orders.put(stamp(order))
        await closeOpenPallets(order.id, at)
        await reconcilePalletCounts(order)
      }
    }
    await db.segments.put(newSegment(snap.workday.id, 'idle', at))
    return
  }

  const next = nextOrderPhase(current)
  if (!next) return
  await closeActive(at)
  const order = orderId ? await db.orders.get(orderId) : undefined
  await db.segments.put(newSegment(snap.workday.id, next, at, {
    orderId,
    palletId: order?.activePalletId,
  }))
}

/** Enregistre les supports et le total réel. Ne touche pas aux chronos. */
export async function saveOrderResult(
  orderId: string,
  data: {
    colisActual: number
    supports: Supports
    orderType: OrderType
    palletSupports?: Array<{ id: string; support?: OrderPallet['support'] }>
    additionalPallets?: Array<{ support?: OrderPallet['support'] }>
  },
): Promise<void> {
  const order = await db.orders.get(orderId)
  if (!order) return
  order.colisActual = data.colisActual
  order.supports = data.supports
  order.orderType = data.orderType
  await db.orders.put(stamp(order))
  for (const choice of data.palletSupports ?? []) {
    const pallet = await db.orderPallets.get(choice.id)
    if (!pallet || pallet.orderId !== orderId) continue
    pallet.support = choice.support
    await db.orderPallets.put(stamp(pallet))
  }
  if (data.additionalPallets?.length) {
    const existing = await db.orderPallets.where('orderId').equals(orderId).toArray()
    let number = Math.max(0, ...existing.map((pallet) => pallet.number))
    const storeTotals = [1, 2].map((storeNumber) =>
      existing.filter((pallet) => pallet.storeNumber === storeNumber && !pallet.deletedAt).length,
    )
    await db.orderPallets.bulkPut(data.additionalPallets.map((input) => {
      const storeNumber: 1 | 2 = order.storeCount === 2 && storeTotals[1] < storeTotals[0] ? 2 : 1
      storeTotals[storeNumber - 1] += 1
      return stamp({
        id: uid(), workdayId: order.workdayId, orderId, number: ++number,
        storeNumber, support: input.support,
        startedAt: order.startedAt, startCount: 0,
        updatedAt: 0, syncState: 'pending',
      })
    }))
  }
}

export async function updateOrder(orderId: string, patch: Partial<Order>): Promise<void> {
  const order = await db.orders.get(orderId)
  if (!order) return
  await db.orders.put(stamp({ ...order, ...patch, id: order.id }))
}

/** Corrige les informations d'une palette sans modifier la timeline globale. */
export async function updateOrderPallet(
  palletId: string,
  patch: Partial<Pick<OrderPallet, 'support' | 'startedAt' | 'endedAt' | 'startCount' | 'endCount'>>,
): Promise<void> {
  const pallet = await db.orderPallets.get(palletId)
  if (!pallet) return
  const startedAt = Math.max(0, patch.startedAt ?? pallet.startedAt)
  const endedAt = patch.endedAt ?? pallet.endedAt
  const startCount = Math.max(0, Math.trunc(patch.startCount ?? pallet.startCount))
  const endCount = Math.max(startCount, Math.trunc(patch.endCount ?? pallet.endCount ?? startCount))
  await db.orderPallets.put(stamp({
    ...pallet,
    ...patch,
    startedAt,
    endedAt: endedAt === undefined ? undefined : Math.max(startedAt, endedAt),
    startCount,
    endCount,
    id: pallet.id,
  }))
  if ('support' in patch) {
    const order = await db.orders.get(pallet.orderId)
    if (order) {
      const supports = { ...EMPTY_SUPPORTS }
      const pallets = await db.orderPallets.where('orderId').equals(pallet.orderId).toArray()
      for (const item of pallets) {
        if (!item.deletedAt && item.support) supports[item.support] += 1
      }
      order.supports = supports
      await db.orders.put(stamp(order))
    }
  }
}

// --- Interruptions ---------------------------------------------------------

/**
 * Démarre une interruption. Appuyer sur le bouton d'une interruption déjà en
 * cours la referme : un seul bouton sert à ouvrir et à fermer, ce qui divise
 * par deux le nombre de commandes à retenir en pleine prépa.
 */
export async function startInterruption(
  type: SegmentType,
  at: number = Date.now(),
): Promise<void> {
  const snap = await loadSnapshot()
  const view = deriveView(snap)
  if (!snap.workday || !canInterrupt(view, type)) return

  if (view.active?.type === type && isSuspendingSegment(view.active)) {
    await endInterruption(at)
    return
  }

  if (type === 'pallet_change' && view.order) {
    const previous = await currentOrderPallet(view.order.id)
    if (previous) {
      await closePallet(previous.id, at)
      const all = await db.orderPallets.where('orderId').equals(view.order.id).toArray()
      const next: OrderPallet = stamp({
        id: uid(), workdayId: view.order.workdayId, orderId: view.order.id,
        number: Math.max(0, ...all.map((p) => p.number)) + 1,
        storeNumber: previous.storeNumber, startedAt: at, startCount: 0,
        updatedAt: 0, syncState: 'pending',
      })
      await db.orderPallets.put(next)
      view.order.activePalletId = next.id
      await db.orders.put(stamp(view.order))
    }
  }

  const stack = pushStack(view.active)
  await closeActive(at)
  await db.segments.put(
    newSegment(snap.workday.id, type, at, {
      // L'interruption reste rattachée à la commande qu'elle interrompt.
      orderId: view.order?.status === 'open' ? view.order.id : undefined,
      palletId: view.order?.activePalletId,
      stack,
    }),
  )
}

/** Ferme l'interruption en cours et rouvre ce qu'elle avait suspendu. */
export async function endInterruption(at: number = Date.now()): Promise<void> {
  const snap = await loadSnapshot()
  const active = activeSegment(snap)
  if (!snap.workday || !active || !isSuspendingSegment(active)) return

  const popped = popStack(active)
  await closeActive(at)

  if (!popped) {
    await db.segments.put(newSegment(snap.workday.id, 'idle', at))
    return
  }
  await db.segments.put(
    newSegment(snap.workday.id, popped.resume.type, at, {
      orderId: popped.resume.orderId,
      palletId: popped.resume.orderId
        ? (await db.orders.get(popped.resume.orderId))?.activePalletId
        : undefined,
      stack: popped.rest,
    }),
  )
}

export const AUTOMATIC_TRAVEL_NOTE = 'Détection automatique du chariot'

/**
 * Une action de prélèvement constitue une preuve métier que le chariot est
 * arrivé. Elle ferme en dernier recours un trajet automatique que les capteurs
 * n'auraient pas encore classé immobile.
 */
async function settleAutomaticTravelOnWorkAction(at: number): Promise<void> {
  const view = deriveView(await loadSnapshot())
  if (view.active?.type === 'travel' && view.active.note === AUTOMATIC_TRAVEL_NOTE) {
    await endInterruption(at)
  }
}

/**
 * Bascule un trajet détecté par les capteurs pendant toute la vacation. Le
 * trajet suspend la phase normale en cours et la reprend exactement à l'arrêt.
 * Une pause, un aléa ou une autre interruption déjà ouverte reste prioritaire,
 * et l'automate ne ferme jamais un trajet créé manuellement.
 */
export async function setAutomaticTravel(
  moving: boolean,
  at: number = Date.now(),
): Promise<boolean> {
  const snap = await loadSnapshot()
  const view = deriveView(snap)
  if (!snap.workday) return false

  if (!moving) {
    if (view.active?.type !== 'travel' || view.active.note !== AUTOMATIC_TRAVEL_NOTE) {
      return false
    }
    await endInterruption(at)
    return true
  }

  // Les phases normales de toute la vacation sont automatisables (briefing,
  // poste, attente, commande et rangement). Une interruption explicite reste
  // prioritaire : le mouvement sera réévalué dès qu'elle sera terminée.
  if (view.phase === 'interrupted') return false

  const stack = pushStack(view.active)
  await closeActive(at)
  await db.segments.put(
    newSegment(snap.workday.id, 'travel', at, {
      orderId: view.order?.status === 'open' ? view.order.id : undefined,
      palletId: view.order?.status === 'open' ? view.order.activePalletId : undefined,
      stack,
      note: AUTOMATIC_TRAVEL_NOTE,
    }),
  )
  return true
}

// --- Progression -----------------------------------------------------------

export async function addColis(delta: number, at: number = Date.now()): Promise<void> {
  await settleAutomaticTravelOnWorkAction(at)
  const snap = await loadSnapshot()
  const view = deriveView(snap)
  if (!snap.workday || !view.order) return

  const current = await orderCount(view.order.id, view.order.activePalletId)
  const safeDelta = Math.max(-current, Math.trunc(delta))
  if (safeDelta === 0) return
  const event: ColisEvent = stamp({
    id: uid(),
    workdayId: snap.workday.id,
    orderId: view.order.id,
    palletId: view.order.activePalletId,
    at,
    delta: safeDelta,
    updatedAt: 0,
    syncState: 'pending',
  })
  await db.colisEvents.put(event)
}

export async function colisEventsFor(workdayId: string): Promise<ColisEvent[]> {
  const events = await db.colisEvents.where('workdayId').equals(workdayId).toArray()
  return events.filter((e) => !e.deletedAt).sort((a, b) => a.at - b.at)
}

// --- Ruptures de stock ----------------------------------------------------

export interface StockShortageInput {
  quantity: number
}

function cleanShortageInput(input: StockShortageInput): StockShortageInput {
  const quantity = Math.trunc(input.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('La quantité manquante doit être strictement positive.')
  }
  return { quantity }
}

/** Signale une rupture uniquement lorsqu'une commande est réellement engagée. */
export async function createStockShortage(
  input: StockShortageInput,
  at: number = Date.now(),
): Promise<StockShortage | undefined> {
  await settleAutomaticTravelOnWorkAction(at)
  const snap = await loadSnapshot()
  const view = deriveView(snap)
  if (!snap.workday || !view.inOrder || !view.order) return undefined

  const shortage: StockShortage = stamp({
    id: uid(),
    workdayId: snap.workday.id,
    orderId: view.order.id,
    at,
    ...cleanShortageInput(input),
    resolved: false,
    updatedAt: 0,
    syncState: 'pending',
  })
  await db.stockShortages.put(shortage)
  return shortage
}

export async function updateStockShortage(
  id: string,
  patch: Partial<StockShortageInput> & { resolved?: boolean },
): Promise<void> {
  const current = await db.stockShortages.get(id)
  if (!current || current.deletedAt) return
  const cleaned = cleanShortageInput({
    quantity: patch.quantity ?? current.quantity,
  })
  await db.stockShortages.put(
    stamp({ ...current, ...cleaned, resolved: patch.resolved ?? current.resolved }),
  )
}

export async function setStockShortageResolved(id: string, resolved: boolean): Promise<void> {
  await updateStockShortage(id, { resolved })
}

export async function deleteStockShortage(id: string, at: number = Date.now()): Promise<void> {
  const shortage = await db.stockShortages.get(id)
  if (!shortage || shortage.deletedAt) return
  shortage.deletedAt = at
  const deleted = stamp(shortage)
  deleted.updatedAt = Math.max(deleted.updatedAt, at)
  await db.stockShortages.put(deleted)
}

export async function stockShortagesFor(workdayId: string): Promise<StockShortage[]> {
  const rows = await db.stockShortages.where('workdayId').equals(workdayId).toArray()
  return rows.filter((row) => !row.deletedAt).sort((a, b) => a.at - b.at)
}

export function shortageTotal(rows: StockShortage[], orderId: string): number {
  return rows
    .filter((row) => row.orderId === orderId && !row.deletedAt)
    .reduce((sum, row) => sum + row.quantity, 0)
}

/** Écart qui reste réellement inexpliqué après les ruptures signalées. */
export function unexplainedColis(
  planned: number,
  prepared: number,
  rows: StockShortage[],
  orderId: string,
): number {
  return Math.max(0, planned - prepared - shortageTotal(rows, orderId))
}

// --- Corrections a posteriori ---------------------------------------------

/**
 * Ajuste les bornes d'un segment. Les segments voisins sont recalés pour que la
 * timeline reste continue : sans cela, corriger un oubli créerait un trou et
 * fausserait toutes les cadences de la journée.
 */
export async function editSegmentBounds(
  segmentId: string,
  bounds: { startedAt?: number; endedAt?: number },
  now: number = Date.now(),
): Promise<void> {
  const segment = await db.segments.get(segmentId)
  if (!segment) return
  const all = (await db.segments.where('workdayId').equals(segment.workdayId).toArray())
    .filter((s) => !s.deletedAt)
    .sort((a, b) => a.startedAt - b.startedAt)

  const index = all.findIndex((s) => s.id === segmentId)
  const prev = all[index - 1]
  const next = all[index + 1]

  if (bounds.startedAt !== undefined) {
    const min = prev ? prev.startedAt + 1000 : Number.NEGATIVE_INFINITY
    // Un chrono ouvert ne possède pas encore de borne de fin : l'instant
    // présent joue ce rôle pour interdire un début dans le futur.
    const max = segment.endedAt ?? now
    const value = Math.min(Math.max(bounds.startedAt, min), max)
    segment.startedAt = value
    if (prev) {
      prev.endedAt = value
      await db.segments.put(stamp(prev))
    }
  }

  const wasOpen = segment.endedAt === undefined
  if (bounds.endedAt !== undefined) {
    const min = segment.startedAt
    const max = next?.endedAt ?? now
    const value = Math.min(Math.max(bounds.endedAt, min), max)
    segment.endedAt = value
    if (next) {
      next.startedAt = value
      await db.segments.put(stamp(next))
    }
  }

  segment.editedAt = Date.now()
  await db.segments.put(stamp(segment))
  const stillOpen = await db.segments
    .where('workdayId')
    .equals(segment.workdayId)
    .filter((row) => !row.deletedAt && row.endedAt === undefined)
    .count()
  const workday = await db.workdays.get(segment.workdayId)
  if (wasOpen && segment.endedAt !== undefined && stillOpen === 0 && workday?.status === 'open') {
    await closeWorkdayAt(segment.workdayId, (await plausibleEndFor(segment.workdayId)) ?? segment.endedAt)
  } else {
    await reconcileWorkdayBounds(segment.workdayId)
  }
}

/** Supprime un segment ; le précédent absorbe sa durée pour éviter un trou. */
export async function deleteSegment(segmentId: string): Promise<void> {
  const segment = await db.segments.get(segmentId)
  if (!segment) return
  const all = (await db.segments.where('workdayId').equals(segment.workdayId).toArray())
    .filter((s) => !s.deletedAt)
    .sort((a, b) => a.startedAt - b.startedAt)

  const index = all.findIndex((s) => s.id === segmentId)
  const prev = all[index - 1]
  const next = all[index + 1]

  if (prev && segment.endedAt !== undefined) {
    prev.endedAt = segment.endedAt
    await db.segments.put(stamp(prev))
  } else if (next) {
    next.startedAt = segment.startedAt
    await db.segments.put(stamp(next))
  }

  segment.deletedAt = Date.now()
  await db.segments.put(stamp(segment))
  await reconcileWorkdayBounds(segment.workdayId)
}

/** Change le type d'un segment (erreur de bouton en pleine prépa). */
export async function retypeSegment(segmentId: string, type: SegmentType): Promise<void> {
  const segment = await db.segments.get(segmentId)
  if (!segment) return
  segment.type = type
  segment.editedAt = Date.now()
  await db.segments.put(stamp(segment))
}

export async function setSegmentNote(segmentId: string, note: string): Promise<void> {
  const segment = await db.segments.get(segmentId)
  if (!segment) return
  segment.note = note.trim() || undefined
  await db.segments.put(stamp(segment))
}

// --- Historique ------------------------------------------------------------

/**
 * Rattache au compte les lignes créées avant toute connexion.
 *
 * Sans cela, ces lignes restent sans propriétaire : elles s'affichent bien dans
 * le suivi personnel — qui les tolère — mais deviennent introuvables dès qu'on
 * cherche la production d'un compte précis, comme le fait la vue d'équipe. Les
 * repasser en attente les fait aussi remonter au serveur sous le bon compte.
 *
 * Ne touche jamais aux lignes déjà attribuées : la production d'un collègue,
 * descendue chez un gestionnaire, garde son propriétaire d'origine.
 */
export async function claimOrphans(ownerId: string): Promise<number> {
  let claimed = 0
  const at = Date.now()

  await db.transaction(
    'rw',
    [db.workdays, db.orders, db.orderPallets, db.segments, db.colisEvents, db.stockShortages],
    async () => {
      for (const table of [
        db.workdays,
        db.orders,
        db.orderPallets,
        db.segments,
        db.colisEvents,
        db.stockShortages,
      ]) {
        claimed += await (
          table as Table<
            { ownerId?: string; updatedAt: number; syncState: 'pending' | 'synced' },
            string
          >
        )
          .filter((row) => row.ownerId === undefined)
          .modify((row) => {
            row.ownerId = ownerId
            row.updatedAt = at
            row.syncState = 'pending'
          })
      }
    },
  )

  return claimed
}

/**
 * Supprime une vacation entière : commandes, chronos et comptages.
 *
 * Suppression logique, comme partout ailleurs : une ligne réellement effacée
 * redescendrait du serveur à la synchro suivante. Les lignes repassent en
 * attente pour que la suppression se propage à l'autre appareil.
 */
export async function deleteWorkday(workdayId: string): Promise<void> {
  const at = Date.now()
  const mark = (row: { deletedAt?: number; updatedAt: number; syncState: string }) => {
    row.deletedAt = at
    row.updatedAt = at
    row.syncState = 'pending'
  }

  await db.transaction(
    'rw',
    [db.workdays, db.orders, db.orderPallets, db.segments, db.colisEvents, db.stockShortages],
    async () => {
      const workday = await db.workdays.get(workdayId)
      if (!workday) return
      // Une vacation encore ouverte doit aussi être close, sinon l'application
      // la rouvrirait au prochain démarrage.
      workday.status = 'closed'
      mark(workday)
      await db.workdays.put(workday)

      await db.orders.where('workdayId').equals(workdayId).modify(mark)
      await db.orderPallets.where('workdayId').equals(workdayId).modify(mark)
      await db.segments.where('workdayId').equals(workdayId).modify(mark)
      await db.colisEvents.where('workdayId').equals(workdayId).modify(mark)
      await db.stockShortages.where('workdayId').equals(workdayId).modify(mark)
    },
  )
  // `mark` n'utilise volontairement pas `stamp` dans la transaction. Recopie
  // donc explicitement les tombstones dans le miroir natif après le commit.
  scheduleDurableBackup()
}

/** Les vacations du compte courant. */
export async function listWorkdays(limit = 60): Promise<Workday[]> {
  const days = await db.workdays
    .orderBy('startedAt')
    .reverse()
    .filter((d) => !d.deletedAt && ownedByCurrent(d))
    .limit(limit)
    .toArray()
  return days
}

/**
 * Les vacations d'un compte donné, ou de tout le monde. Réservé à la vue
 * d'équipe : les écrans de suivi personnel passent par `listWorkdays`.
 */
export async function listWorkdaysOf(ownerId?: string, limit = 200): Promise<Workday[]> {
  return db.workdays
    .orderBy('startedAt')
    .reverse()
    .filter((d) => !d.deletedAt && (ownerId === undefined || d.ownerId === ownerId))
    .limit(limit)
    .toArray()
}
