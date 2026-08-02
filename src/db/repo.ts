import type { Table } from 'dexie'
import { db, uid } from './db'
import { activeSegment, deriveView, nextOrderPhase, popStack, pushStack } from '../core/machine'
import type { Snapshot } from '../core/machine'
import { isInterruption } from '../core/segments'
import { dayKey } from '../core/time'
import { currentOwnerId, ownedByCurrent } from '../sync/profile'
import type {
  ColisEvent,
  Order,
  OrderType,
  Segment,
  SegmentType,
  SuspendedRef,
  Supports,
  Workday,
} from '../core/types'
import { EMPTY_SUPPORTS } from '../core/types'

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
  const [segments, orders] = await Promise.all([
    db.segments.where('workdayId').equals(workday.id).toArray(),
    db.orders.where('workdayId').equals(workday.id).toArray(),
  ])
  return {
    workday,
    segments: segments.filter((s) => !s.deletedAt).sort((a, b) => a.startedAt - b.startedAt),
    orders: orders.filter((o) => !o.deletedAt).sort((a, b) => a.startedAt - b.startedAt),
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
  opts: { orderId?: string; stack?: SuspendedRef[] } = {},
): Segment {
  return stamp({
    id: uid(),
    workdayId,
    type,
    startedAt: at,
    orderId: opts.orderId,
    stack: opts.stack && opts.stack.length > 0 ? opts.stack : undefined,
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
  }

  workday.status = 'closed'
  workday.endedAt = end
  await db.workdays.put(stamp(workday))
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
}

export async function startOrder(
  input: NewOrderInput,
  at: number = Date.now(),
): Promise<Order | undefined> {
  const snap = await loadSnapshot()
  if (!snap.workday) return undefined

  const order: Order = stamp({
    id: uid(),
    workdayId: snap.workday.id,
    status: 'open',
    orderType: input.orderType,
    colisPlanned: input.colisPlanned,
    linesCount: input.linesCount,
    supports: { ...EMPTY_SUPPORTS },
    startedAt: at,
    updatedAt: 0,
    syncState: 'pending',
  })
  await db.orders.put(order)

  await closeActive(at)
  await db.segments.put(newSegment(snap.workday.id, 'order_setup', at, { orderId: order.id }))
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
      }
    }
    await db.segments.put(newSegment(snap.workday.id, 'idle', at))
    return
  }

  const next = nextOrderPhase(current)
  if (!next) return
  await closeActive(at)
  await db.segments.put(newSegment(snap.workday.id, next, at, { orderId }))
}

/** Enregistre les supports et le total réel. Ne touche pas aux chronos. */
export async function saveOrderResult(
  orderId: string,
  data: { colisActual: number; supports: Supports; orderType: OrderType },
): Promise<void> {
  const order = await db.orders.get(orderId)
  if (!order) return
  order.colisActual = data.colisActual
  order.supports = data.supports
  order.orderType = data.orderType
  await db.orders.put(stamp(order))
}

export async function updateOrder(orderId: string, patch: Partial<Order>): Promise<void> {
  const order = await db.orders.get(orderId)
  if (!order) return
  await db.orders.put(stamp({ ...order, ...patch, id: order.id }))
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
  if (!snap.workday || !isInterruption(type)) return

  if (view.active?.type === type) {
    await endInterruption(at)
    return
  }

  const stack = pushStack(view.active)
  await closeActive(at)
  await db.segments.put(
    newSegment(snap.workday.id, type, at, {
      // L'interruption reste rattachée à la commande qu'elle interrompt.
      orderId: view.order?.status === 'open' ? view.order.id : undefined,
      stack,
    }),
  )
}

/** Ferme l'interruption en cours et rouvre ce qu'elle avait suspendu. */
export async function endInterruption(at: number = Date.now()): Promise<void> {
  const snap = await loadSnapshot()
  const active = activeSegment(snap)
  if (!snap.workday || !active || !isInterruption(active.type)) return

  const popped = popStack(active)
  await closeActive(at)

  if (!popped) {
    await db.segments.put(newSegment(snap.workday.id, 'idle', at))
    return
  }
  await db.segments.put(
    newSegment(snap.workday.id, popped.resume.type, at, {
      orderId: popped.resume.orderId,
      stack: popped.rest,
    }),
  )
}

// --- Progression -----------------------------------------------------------

export async function addColis(delta: number, at: number = Date.now()): Promise<void> {
  const snap = await loadSnapshot()
  const view = deriveView(snap)
  if (!snap.workday || !view.order) return

  const event: ColisEvent = stamp({
    id: uid(),
    workdayId: snap.workday.id,
    orderId: view.order.id,
    at,
    delta,
    updatedAt: 0,
    syncState: 'pending',
  })
  await db.colisEvents.put(event)
}

export async function colisEventsFor(workdayId: string): Promise<ColisEvent[]> {
  const events = await db.colisEvents.where('workdayId').equals(workdayId).toArray()
  return events.filter((e) => !e.deletedAt).sort((a, b) => a.at - b.at)
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
    const max = segment.endedAt ?? Number.POSITIVE_INFINITY
    const value = Math.min(Math.max(bounds.startedAt, min), max)
    segment.startedAt = value
    if (prev) {
      prev.endedAt = value
      await db.segments.put(stamp(prev))
    }
  }

  if (bounds.endedAt !== undefined && segment.endedAt !== undefined) {
    const min = segment.startedAt
    const max = next?.endedAt ?? Number.POSITIVE_INFINITY
    const value = Math.min(Math.max(bounds.endedAt, min), max)
    segment.endedAt = value
    if (next) {
      next.startedAt = value
      await db.segments.put(stamp(next))
    }
  }

  segment.editedAt = Date.now()
  await db.segments.put(stamp(segment))
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
    [db.workdays, db.orders, db.segments, db.colisEvents],
    async () => {
      for (const table of [db.workdays, db.orders, db.segments, db.colisEvents]) {
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
    [db.workdays, db.orders, db.segments, db.colisEvents],
    async () => {
      const workday = await db.workdays.get(workdayId)
      if (!workday) return
      // Une vacation encore ouverte doit aussi être close, sinon l'application
      // la rouvrirait au prochain démarrage.
      workday.status = 'closed'
      mark(workday)
      await db.workdays.put(workday)

      await db.orders.where('workdayId').equals(workdayId).modify(mark)
      await db.segments.where('workdayId').equals(workdayId).modify(mark)
      await db.colisEvents.where('workdayId').equals(workdayId).modify(mark)
    },
  )
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
