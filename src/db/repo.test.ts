import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  addColis,
  advanceOrder,
  colisEventsFor,
  deleteSegment,
  editSegmentBounds,
  endBriefing,
  endInterruption,
  finishDay,
  listWorkdays,
  loadSnapshot,
  loadSnapshotById,
  saveOrderResult,
  startCleanup,
  startDay,
  startInterruption,
  startOrder,
  toggleOvertime,
} from './repo'
import { deriveView } from '../core/machine'
import { computeDayMetrics, computeOrderMetrics, segmentDuration } from '../core/metrics'
import { MINUTE } from '../core/time'
import { EMPTY_SUPPORTS } from '../core/types'

/** 30 juillet 2026, 13h00 : début d'une vacation type. */
const START = new Date(2026, 6, 30, 13, 0, 0).getTime()
const at = (minutes: number) => START + minutes * MINUTE

beforeEach(async () => {
  await db.delete()
  await db.open()
})

async function phase() {
  return deriveView(await loadSnapshot()).phase
}

/** Recharge la vacation la plus récente, close ou non. */
async function loadLastDay() {
  const days = await listWorkdays()
  return (await loadSnapshotById(days[0].id))!
}

describe('déroulement d’une vacation', () => {
  it('enchaîne briefing → prépa poste automatiquement', async () => {
    await startDay(at(0))
    expect(await phase()).toBe('briefing')

    await endBriefing(at(10))
    expect(await phase()).toBe('poste_prep')

    const snap = await loadSnapshot()
    const briefing = snap.segments.find((s) => s.type === 'briefing')!
    expect(segmentDuration(briefing)).toBe(10 * MINUTE)
    // Aucun trou : la prépa poste démarre exactement quand le briefing finit.
    expect(snap.segments.find((s) => s.type === 'poste_prep')!.startedAt).toBe(briefing.endedAt)
  })

  it('suit les quatre phases d’une commande', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 120, linesCount: 40, orderType: 'normale' }, at(15))
    expect(await phase()).toBe('order_setup')

    await advanceOrder(at(20))
    expect(await phase()).toBe('picking')

    await advanceOrder(at(70))
    expect(await phase()).toBe('wrapping')

    await advanceOrder(at(75))
    expect(await phase()).toBe('docking')

    await advanceOrder(at(80))
    // La commande est close et on repasse en attente, sans trou de timeline.
    expect(await phase()).toBe('ready')
    const snap = await loadSnapshot()
    expect(snap.orders[0].status).toBe('done')
    expect(snap.orders[0].endedAt).toBe(at(80))
  })

  it('clôt la prépa poste quand la première commande démarre', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 50, linesCount: 10, orderType: 'normale' }, at(15))
    const snap = await loadSnapshot()
    const poste = snap.segments.find((s) => s.type === 'poste_prep')!
    expect(poste.endedAt).toBe(at(15))
  })
})

describe('interruptions', () => {
  it('suspend la prépa et la reprend à l’identique', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 120, linesCount: 40, orderType: 'normale' }, at(15))
    await advanceOrder(at(20)) // picking

    await startInterruption('travel', at(30))
    expect(await phase()).toBe('interrupted')

    await endInterruption(at(35))
    const snap = await loadSnapshot()
    const view = deriveView(snap)
    expect(view.phase).toBe('picking')
    expect(view.active?.orderId).toBe(snap.orders[0].id)

    // Deux segments de prépa distincts, séparés par le trajet.
    const pickings = snap.segments.filter((s) => s.type === 'picking')
    expect(pickings).toHaveLength(2)
    expect(pickings[0].endedAt).toBe(at(30))
    expect(pickings[1].startedAt).toBe(at(35))
  })

  it('referme l’interruption si on rappuie sur le même bouton', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 60, linesCount: 20, orderType: 'normale' }, at(15))
    await advanceOrder(at(20))

    await startInterruption('travel', at(25))
    await startInterruption('travel', at(28)) // deuxième appui = fin du trajet
    expect(await phase()).toBe('picking')

    const snap = await loadSnapshot()
    expect(snap.segments.filter((s) => s.type === 'travel')).toHaveLength(1)
  })

  it('gère une pause déclenchée pendant un trajet', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 60, linesCount: 20, orderType: 'normale' }, at(15))
    await advanceOrder(at(20))

    await startInterruption('travel', at(25))
    await startInterruption('break_10', at(27))

    let view = deriveView(await loadSnapshot())
    expect(view.phase).toBe('interrupted')
    expect(view.active?.type).toBe('break_10')
    expect(view.resuming).toBe('travel')
    expect(view.depth).toBe(2)

    await endInterruption(at(37))
    view = deriveView(await loadSnapshot())
    expect(view.active?.type).toBe('travel')
    expect(view.resuming).toBe('picking')

    await endInterruption(at(40))
    view = deriveView(await loadSnapshot())
    expect(view.active?.type).toBe('picking')
    expect(view.depth).toBe(0)
  })

  it('reprend en attente si l’interruption n’a rien suspendu', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 10, linesCount: 2, orderType: 'normale' }, at(15))
    await advanceOrder(at(16))
    await advanceOrder(at(20))
    await advanceOrder(at(22))
    await advanceOrder(at(24)) // -> idle

    await startInterruption('break_30', at(30))
    await endInterruption(at(60))
    expect(await phase()).toBe('ready')
  })
})

describe('continuité de la timeline', () => {
  it('ne laisse ni trou ni chevauchement sur une vacation complète', async () => {
    await runFullShift()
    const snap = await loadLastDay()
    const segs = snap.segments
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].startedAt).toBe(segs[i - 1].endedAt)
    }
    const total = segs.reduce((sum, s) => sum + segmentDuration(s), 0)
    expect(total).toBe(snap.workday!.endedAt! - snap.workday!.startedAt)
  })
})

describe('cadences', () => {
  it('calcule séparément prépa pure, commande et journée', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 120, linesCount: 40, orderType: 'normale' }, at(15))
    await advanceOrder(at(20)) // picking, setup = 5 min

    await startInterruption('travel', at(30)) // picking 10 min
    await endInterruption(at(35)) // travel 5 min
    await startInterruption('pallet_change', at(50)) // picking 15 min
    await endInterruption(at(53)) // palette 3 min

    await advanceOrder(at(80)) // picking 27 min -> filmage
    await advanceOrder(at(85)) // filmage 5 min -> quai
    await advanceOrder(at(90)) // quai 5 min -> commande close

    const orderId = (await loadSnapshot()).orders[0].id
    await saveOrderResult(orderId, {
      colisActual: 120,
      supports: { ...EMPTY_SUPPORTS, europe: 2 },
      orderType: 'normale',
    })

    const snap = await loadSnapshot()
    const events = await colisEventsFor(snap.workday!.id)
    const m = computeOrderMetrics(snap.orders[0], snap.segments, events)

    expect(m.picking).toBe(52 * MINUTE) // 10 + 15 + 27
    expect(m.setup).toBe(5 * MINUTE)
    expect(m.interruptions).toBe(8 * MINUTE) // trajet 5 + palette 3
    // Le changement de palette est subi : la palette est pleine, il faut la
    // déposer. Le compter ferait baisser la cadence sans rapport avec le rythme.
    expect(m.imposed).toBe(3 * MINUTE)
    // 5 (palette) + 52 (prépa) + 8 (interruptions) + 5 (filmage) + 5 (quai)
    // − 3 (changement de palette, subi)
    expect(m.totalWorked).toBe(72 * MINUTE)
    expect(m.ratePicking).toBeCloseTo(120 / (52 / 60), 4)
    expect(m.rateOrder).toBeCloseTo(120 / (72 / 60), 4)
    expect(m.colisPerLine).toBeCloseTo(3, 6)
    expect(m.palletChanges).toBe(1)
  })

  it('exclut les pauses réglementaires du temps de commande', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 100, linesCount: 25, orderType: 'normale' }, at(15))
    await advanceOrder(at(20))
    await startInterruption('break_30', at(40)) // pause en pleine commande
    await endInterruption(at(70))
    await advanceOrder(at(90))
    await advanceOrder(at(95))
    await advanceOrder(at(100))

    const snap = await loadSnapshot()
    const orderId = snap.orders[0].id
    await saveOrderResult(orderId, {
      colisActual: 100,
      supports: { ...EMPTY_SUPPORTS, ipp: 1 },
      orderType: 'normale',
    })

    const fresh = await loadSnapshot()
    const events = await colisEventsFor(fresh.workday!.id)
    const m = computeOrderMetrics(fresh.orders[0], fresh.segments, events)

    expect(m.breaks).toBe(30 * MINUTE)
    expect(m.picking).toBe(40 * MINUTE) // 20 avant la pause + 20 après
    // 5 (setup) + 40 (prépa) + 5 (filmage) + 5 (quai), pause exclue
    expect(m.totalWorked).toBe(55 * MINUTE)
  })

  it('agrège correctement la journée', async () => {
    await runFullShift()
    const snap = await loadLastDay()
    const events = await colisEventsFor(snap.workday!.id)
    const day = computeDayMetrics(snap, events, 110)

    expect(day.ordersCount).toBe(2)
    expect(day.colis).toBe(300)
    expect(day.presence).toBe(day.worked + day.breaks)
    // Pauses réellement prises, dépassements compris : 11 + 32 + 11.
    expect(day.breaks).toBe(54 * MINUTE)
    expect(day.rates.day).toBeCloseTo(300 / (day.worked / 3_600_000), 4)
    // Le temps perdu se convertit en colis manqués à la cadence cible.
    expect(day.lostColis).toBeCloseTo((day.wasteTime / 3_600_000) * 110, 6)
  })
})

describe('compteur de progression', () => {
  it('cumule les appuis et alimente la cadence en cours', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 120, linesCount: 40, orderType: 'normale' }, at(15))
    await advanceOrder(at(20))

    await addColis(10, at(25))
    await addColis(10, at(30))
    await addColis(-1, at(31))

    const snap = await loadSnapshot()
    const events = await colisEventsFor(snap.workday!.id)
    expect(events.reduce((s, e) => s + e.delta, 0)).toBe(19)

    const m = computeOrderMetrics(snap.orders[0], snap.segments, events, at(35))
    expect(m.colis).toBe(19)
  })
})

describe('heures supplémentaires', () => {
  it('ne compte que le temps postérieur au marqueur', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await toggleOvertime(at(30))
    await startCleanup(at(40))
    await finishDay(at(50))

    const snap = await loadLastDay()
    const day = computeDayMetrics(snap, [], 110)
    expect(day.overtime).toBe(20 * MINUTE)
  })
})

describe('corrections a posteriori', () => {
  it('recale le voisin quand on déplace une borne', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 50, linesCount: 10, orderType: 'normale' }, at(20))

    const snap = await loadSnapshot()
    const poste = snap.segments.find((s) => s.type === 'poste_prep')!
    // Le briefing avait en réalité duré jusqu'à 13h05, pas 13h10.
    await editSegmentBounds(poste.id, { startedAt: at(5) })

    const after = await loadSnapshot()
    expect(after.segments.find((s) => s.type === 'briefing')!.endedAt).toBe(at(5))
    expect(after.segments.find((s) => s.type === 'poste_prep')!.startedAt).toBe(at(5))
  })

  it('refuse de créer une durée négative', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 50, linesCount: 10, orderType: 'normale' }, at(20))

    const snap = await loadSnapshot()
    const poste = snap.segments.find((s) => s.type === 'poste_prep')!
    await editSegmentBounds(poste.id, { startedAt: at(60) })

    const after = await loadSnapshot()
    const fixed = after.segments.find((s) => s.id === poste.id)!
    expect(fixed.startedAt).toBeLessThanOrEqual(fixed.endedAt!)
  })

  it('absorbe la durée d’un segment supprimé dans le précédent', async () => {
    await startDay(at(0))
    await endBriefing(at(10))
    await startOrder({ colisPlanned: 50, linesCount: 10, orderType: 'normale' }, at(15))
    await advanceOrder(at(20))
    await startInterruption('toilet', at(30))
    await endInterruption(at(35))

    const snap = await loadSnapshot()
    const toilet = snap.segments.find((s) => s.type === 'toilet')!
    await deleteSegment(toilet.id)

    const after = await loadSnapshot()
    expect(after.segments.some((s) => s.type === 'toilet')).toBe(false)
    const pickings = after.segments.filter((s) => s.type === 'picking')
    expect(pickings[0].endedAt).toBe(at(35))
    // La timeline reste continue après suppression.
    for (let i = 1; i < after.segments.length; i++) {
      expect(after.segments[i].startedAt).toBe(after.segments[i - 1].endedAt)
    }
  })
})

/**
 * Vacation complète de référence : briefing, deux commandes, trois pauses,
 * trajets, une panne matériel, rangement. Sert de garde-fou global — une
 * erreur de comptage du temps est invisible à l'œil nu dans l'interface.
 */
async function runFullShift() {
  await startDay(at(0)) // 13h00 briefing
  await endBriefing(at(12)) // 13h12 prépa poste

  // Commande 1 — 180 colis
  await startOrder({ colisPlanned: 180, linesCount: 60, orderType: 'normale' }, at(20))
  await advanceOrder(at(26)) // prépa
  await addColis(50, at(45))
  await startInterruption('travel', at(50))
  await endInterruption(at(56))
  await addColis(60, at(75))
  await startInterruption('pallet_change', at(78))
  await endInterruption(at(82))
  await startInterruption('break_10', at(95))
  await endInterruption(at(106))
  await addColis(70, at(120))
  await advanceOrder(at(125)) // filmage
  await advanceOrder(at(131)) // quai
  await advanceOrder(at(137)) // close

  await startInterruption('break_30', at(140))
  await endInterruption(at(172))

  // Commande 2 — 120 colis, avec une panne d'engin
  await startOrder({ colisPlanned: 120, linesCount: 30, orderType: 'urbaine' }, at(180))
  await advanceOrder(at(187))
  await startInterruption('incident_material', at(200))
  await endInterruption(at(215))
  await addColis(120, at(240))
  await advanceOrder(at(245))
  await advanceOrder(at(250))
  await advanceOrder(at(256))

  await startInterruption('break_10', at(260))
  await endInterruption(at(271))

  await toggleOvertime(at(390)) // 19h30 : passage en heures supp
  await startCleanup(at(400))
  await finishDay(at(410)) // 19h50

  const snap = await loadLastDay()
  const [first, second] = snap.orders
  await saveOrderResult(first.id, {
    colisActual: 180,
    supports: { ...EMPTY_SUPPORTS, europe: 2, ipp: 1 },
    orderType: 'normale',
  })
  await saveOrderResult(second.id, {
    colisActual: 120,
    supports: { ...EMPTY_SUPPORTS, vmax: 1 },
    orderType: 'urbaine',
  })
}
