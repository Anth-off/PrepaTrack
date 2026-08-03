import { BREAK_TYPES, isInterruption, segmentDef } from './segments'
import type { Order, Segment, SegmentType, SuspendedRef, Workday } from './types'

/**
 * Logique pure de la machine à états. Aucune dépendance à la base : elle prend
 * un instantané de la journée et en déduit l'état courant et les actions
 * possibles. Le repository (`src/db/repo.ts`) est le seul à écrire, en
 * s'appuyant sur ces règles.
 */

export interface Snapshot {
  workday?: Workday
  /** Segments de la journée, ordre chronologique. */
  segments: Segment[]
  orders: Order[]
}

export type Phase =
  | 'no_day' // aucune vacation ouverte
  | 'briefing'
  | 'poste_prep'
  | 'ready' // entre deux commandes
  | 'order_setup'
  | 'picking'
  | 'wrapping'
  | 'docking'
  | 'cleanup'
  | 'interrupted' // une interruption est en cours, la phase réelle est dans la pile

export interface MachineView {
  phase: Phase
  /**
   * Type du segment réellement en cours « sous » les interruptions : c'est le
   * fond de pile. Un trajet déclenché pendant le filmage a `phase` à
   * `interrupted` mais `basePhase` à `wrapping` — indispensable pour savoir
   * quoi afficher, le compteur de colis n'ayant aucun sens à ce moment-là.
   */
  basePhase: SegmentType
  active?: Segment
  /** Commande en cours, si le segment actif ou la pile en concerne une. */
  order?: Order
  /** Phase qui reprendra à la fermeture de l'interruption courante. */
  resuming?: SegmentType
  /** Profondeur d'empilement des interruptions. */
  depth: number
  /** Vrai dès qu'une commande est engagée, y compris pendant une interruption. */
  inOrder: boolean
}

/** Empiler plus profond signale presque toujours un oubli de fermeture. */
export const MAX_STACK_DEPTH = 4

/**
 * Correspondance explicite entre type de segment et phase. Les interruptions
 * n'y figurent pas : elles produisent toujours la phase `interrupted`.
 */
const PHASE_BY_SEGMENT: Partial<Record<SegmentType, Phase>> = {
  briefing: 'briefing',
  poste_prep: 'poste_prep',
  idle: 'ready',
  cleanup: 'cleanup',
  order_setup: 'order_setup',
  picking: 'picking',
  wrapping: 'wrapping',
  docking: 'docking',
}

export function activeSegment(snap: Snapshot): Segment | undefined {
  return snap.segments.find((s) => s.endedAt === undefined && !s.deletedAt)
}

/**
 * Un filmage peut suspendre provisoirement le prélèvement sans devenir un
 * nouveau type d'aléa. Sa pile non vide le distingue du filmage final, qui est
 * une phase normale de la commande et n'a donc rien à reprendre.
 */
export function isSuspendingSegment(segment: Segment): boolean {
  return (
    isInterruption(segment.type) ||
    (segment.type === 'wrapping' && (segment.stack?.length ?? 0) > 0)
  )
}

export function deriveView(snap: Snapshot): MachineView {
  if (!snap.workday || snap.workday.status === 'closed') {
    return { phase: 'no_day', basePhase: 'idle', depth: 0, inOrder: false }
  }

  const active = activeSegment(snap)
  if (!active) {
    return { phase: 'ready', basePhase: 'idle', depth: 0, inOrder: false }
  }

  const stack = active.stack ?? []
  const interrupted = isSuspendingSegment(active)

  // La commande concernée est celle du segment actif, sinon celle du segment
  // suspendu le plus profond : une pause prise pendant une prépa reste
  // rattachée à sa commande.
  const orderId = active.orderId ?? [...stack].reverse().find((r) => r.orderId)?.orderId
  const order = orderId ? snap.orders.find((o) => o.id === orderId) : undefined

  if (interrupted) {
    const resume = stack[stack.length - 1]
    return {
      phase: 'interrupted',
      // Le fond de pile est toujours un segment principal : c'est lui qui dit
      // où on en est vraiment dans la commande.
      basePhase: stack[0]?.type ?? active.type,
      active,
      order,
      resuming: resume?.type,
      depth: stack.length,
      inOrder: Boolean(order && order.status === 'open'),
    }
  }

  return {
    phase: PHASE_BY_SEGMENT[active.type] ?? 'ready',
    basePhase: active.type,
    active,
    order,
    depth: 0,
    inOrder: Boolean(order && order.status === 'open'),
  }
}

/** Pile à porter par une interruption démarrée alors que `active` est en cours. */
export function pushStack(active: Segment | undefined): SuspendedRef[] {
  if (!active) return []
  const base = active.stack ?? []
  return [...base, { type: active.type, orderId: active.orderId }]
}

/** Ce qu'il faut rouvrir en fermant `active` : le sommet de pile, et le reste. */
export function popStack(
  active: Segment,
): { resume: SuspendedRef; rest: SuspendedRef[] } | undefined {
  const stack = active.stack ?? []
  if (stack.length === 0) return undefined
  return { resume: stack[stack.length - 1], rest: stack.slice(0, -1) }
}

/** Phase suivante dans le déroulement d'une commande. */
export function nextOrderPhase(type: SegmentType): SegmentType | undefined {
  switch (type) {
    case 'order_setup':
      return 'picking'
    case 'picking':
      return 'wrapping'
    case 'wrapping':
      return 'docking'
    default:
      return undefined
  }
}

/** Peut-on démarrer une interruption de ce type maintenant ? */
export function canInterrupt(view: MachineView, type: SegmentType): boolean {
  if (view.phase === 'no_day') return false
  const inPrepWrapping = type === 'wrapping'
  if (!isInterruption(type) && !inPrepWrapping) return false
  // Appuyer sur le bouton d'une interruption déjà en cours la referme : c'est
  // un basculement, pas un empilement.
  if (view.active?.type === type) return isSuspendingSegment(view.active)
  if (view.depth >= MAX_STACK_DEPTH) return false
  // Le filmage intermédiaire part uniquement du prélèvement lui-même. Le
  // filmage final porte le même type, mais reste piloté par le bouton principal.
  if (inPrepWrapping) {
    return view.phase === 'picking' && view.inOrder && view.basePhase === 'picking'
  }
  // Un changement de palette n'a de sens qu'en cours de prélèvement : pendant
  // la recherche de palette, le filmage ou la mise à quai, il n'y a rien à
  // déposer. L'autoriser ailleurs ne produirait que des saisies erronées.
  if (type === 'pallet_change' && (!view.inOrder || view.basePhase !== 'picking')) return false
  return true
}

/** Le libellé du bouton principal, en fonction de la phase. */
export function primaryActionLabel(view: MachineView): string {
  switch (view.phase) {
    case 'no_day':
      return 'Commencer la journée'
    case 'briefing':
      return 'Fin du briefing'
    case 'poste_prep':
      return 'Nouvelle commande'
    case 'ready':
      return 'Nouvelle commande'
    case 'order_setup':
      return 'Début de la prépa'
    case 'picking':
      return 'Fin de la prépa'
    case 'wrapping':
      return 'Fin du filmage'
    case 'docking':
      return 'Fin de la mise à quai'
    case 'cleanup':
      return 'Terminer la journée'
    case 'interrupted':
      return `Fin — ${segmentDef(view.active!.type).label}`
  }
}

/** Nombre de pauses déjà prises, par type, pour l'affichage du sélecteur. */
export function breaksTaken(snap: Snapshot): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const type of BREAK_TYPES) counts[type] = 0
  for (const s of snap.segments) {
    if (s.deletedAt) continue
    if (BREAK_TYPES.includes(s.type)) counts[s.type] = (counts[s.type] ?? 0) + 1
  }
  return counts
}
