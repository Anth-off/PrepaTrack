import { describe, expect, it } from 'vitest'
import {
  canInterrupt,
  deriveView,
  nextOrderPhase,
  popStack,
  primaryActionLabel,
  pushStack,
  type Snapshot,
} from './machine'
import type { Order, Segment, SegmentType, Workday } from './types'
import { EMPTY_SUPPORTS } from './types'

const T = 1_700_000_000_000

function seg(type: SegmentType, startedAt: number, extra: Partial<Segment> = {}): Segment {
  return {
    id: `${type}-${startedAt}`,
    workdayId: 'w1',
    type,
    startedAt,
    updatedAt: 0,
    syncState: 'pending',
    ...extra,
  }
}

const workday: Workday = {
  id: 'w1',
  date: '2026-07-30',
  status: 'open',
  startedAt: T,
  updatedAt: 0,
  syncState: 'pending',
}

const order: Order = {
  id: 'o1',
  workdayId: 'w1',
  status: 'open',
  orderType: 'normale',
  colisPlanned: 120,
  linesCount: 40,
  supports: { ...EMPTY_SUPPORTS },
  startedAt: T,
  updatedAt: 0,
  syncState: 'pending',
}

function snap(segments: Segment[], orders: Order[] = [order]): Snapshot {
  return { workday, segments, orders }
}

describe('deriveView', () => {
  it('renvoie no_day sans vacation ouverte', () => {
    expect(deriveView({ segments: [], orders: [] }).phase).toBe('no_day')
    expect(
      deriveView({ workday: { ...workday, status: 'closed' }, segments: [], orders: [] }).phase,
    ).toBe('no_day')
  })

  it('reflète le type du segment ouvert', () => {
    const view = deriveView(snap([seg('briefing', T, { endedAt: T + 1000 }), seg('picking', T + 1000, { orderId: 'o1' })]))
    expect(view.phase).toBe('picking')
    expect(view.inOrder).toBe(true)
    expect(view.order?.id).toBe('o1')
  })

  it('passe en interrupted et indique ce qui reprendra', () => {
    const view = deriveView(
      snap([
        seg('picking', T, { orderId: 'o1', endedAt: T + 1000 }),
        seg('travel', T + 1000, { orderId: 'o1', stack: [{ type: 'picking', orderId: 'o1' }] }),
      ]),
    )
    expect(view.phase).toBe('interrupted')
    expect(view.resuming).toBe('picking')
    expect(view.depth).toBe(1)
    expect(view.inOrder).toBe(true)
  })

  it('rattache une pause imbriquée à la commande suspendue en profondeur', () => {
    const view = deriveView(
      snap([
        seg('break_10', T, {
          stack: [
            { type: 'picking', orderId: 'o1' },
            { type: 'travel' },
          ],
        }),
      ]),
    )
    expect(view.order?.id).toBe('o1')
    expect(view.resuming).toBe('travel')
    expect(view.depth).toBe(2)
  })

  it('expose la phase réelle sous les interruptions', () => {
    // Trajet déclenché pendant le filmage : le compteur de colis ne doit plus
    // s'afficher, la prépa est terminée.
    const wrapping = deriveView(
      snap([seg('travel', T, { orderId: 'o1', stack: [{ type: 'wrapping', orderId: 'o1' }] })]),
    )
    expect(wrapping.phase).toBe('interrupted')
    expect(wrapping.basePhase).toBe('wrapping')

    // Pause imbriquée dans un trajet lui-même pris pendant la prépa.
    const nested = deriveView(
      snap([
        seg('break_10', T, {
          stack: [
            { type: 'picking', orderId: 'o1' },
            { type: 'travel' },
          ],
        }),
      ]),
    )
    expect(nested.basePhase).toBe('picking')

    // Hors interruption, la phase de base est simplement le segment actif.
    expect(deriveView(snap([seg('picking', T, { orderId: 'o1' })])).basePhase).toBe('picking')
  })

  it('ignore les segments supprimés pour trouver le segment actif', () => {
    const view = deriveView(
      snap([seg('travel', T, { deletedAt: T }), seg('picking', T, { orderId: 'o1' })]),
    )
    expect(view.phase).toBe('picking')
  })
})

describe('pile de suspension', () => {
  it('empile le segment courant avec sa commande', () => {
    const stack = pushStack(seg('picking', T, { orderId: 'o1' }))
    expect(stack).toEqual([{ type: 'picking', orderId: 'o1' }])
  })

  it('conserve la pile existante lors d’un empilement', () => {
    const travel = seg('travel', T, { stack: [{ type: 'picking', orderId: 'o1' }] })
    expect(pushStack(travel)).toEqual([
      { type: 'picking', orderId: 'o1' },
      { type: 'travel', orderId: undefined },
    ])
  })

  it('dépile dans l’ordre inverse', () => {
    const popped = popStack(
      seg('break_10', T, {
        stack: [
          { type: 'picking', orderId: 'o1' },
          { type: 'travel' },
        ],
      }),
    )
    expect(popped?.resume.type).toBe('travel')
    expect(popped?.rest).toEqual([{ type: 'picking', orderId: 'o1' }])
  })

  it('renvoie undefined quand il n’y a rien à reprendre', () => {
    expect(popStack(seg('travel', T))).toBeUndefined()
  })
})

describe('enchaînement des phases de commande', () => {
  it('suit setup → prépa → filmage → quai', () => {
    expect(nextOrderPhase('order_setup')).toBe('picking')
    expect(nextOrderPhase('picking')).toBe('wrapping')
    expect(nextOrderPhase('wrapping')).toBe('docking')
    expect(nextOrderPhase('docking')).toBeUndefined()
  })
})

describe('canInterrupt', () => {
  it('refuse tout hors vacation', () => {
    const view = deriveView({ segments: [], orders: [] })
    expect(canInterrupt(view, 'travel')).toBe(false)
  })

  it('autorise le basculement sur l’interruption déjà en cours', () => {
    const view = deriveView(
      snap([seg('travel', T, { stack: [{ type: 'picking', orderId: 'o1' }] })]),
    )
    expect(canInterrupt(view, 'travel')).toBe(true)
  })

  it('refuse un changement de palette hors commande', () => {
    const view = deriveView(snap([seg('idle', T)], []))
    expect(canInterrupt(view, 'pallet_change')).toBe(false)
  })

  it('refuse d’empiler au-delà de la profondeur maximale', () => {
    const view = deriveView(
      snap([
        seg('break_10', T, {
          stack: [
            { type: 'picking', orderId: 'o1' },
            { type: 'travel' },
            { type: 'toilet' },
            { type: 'incident_wait' },
          ],
        }),
      ]),
    )
    expect(canInterrupt(view, 'incident_material')).toBe(false)
  })
})

describe('primaryActionLabel', () => {
  it('propose de commencer la journée quand rien n’est ouvert', () => {
    expect(primaryActionLabel(deriveView({ segments: [], orders: [] }))).toBe(
      'Commencer la journée',
    )
  })

  it('propose de fermer l’interruption en cours', () => {
    const view = deriveView(
      snap([seg('travel', T, { stack: [{ type: 'picking', orderId: 'o1' }] })]),
    )
    expect(primaryActionLabel(view)).toBe('Fin — Trajet')
  })
})
