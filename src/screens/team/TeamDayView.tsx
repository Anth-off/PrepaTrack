import { useMemo, useState } from 'react'
import {
  availableDates,
  byOwnerForDate,
  losses,
  teamDayTotals,
  type DayData,
  type OwnerDay,
  type OwnerDayState,
} from '../../core/analysis'
import { isRateMeaningful } from '../../core/metrics'
import { formatDayLabel, formatShort, hhmm } from '../../core/time'
import { LossTable } from '../../components/LossTable'
import { closeWorkdayAt } from '../../db/repo'
import type { Preparer } from '../../sync/team'

interface Props {
  days: DayData[]
  team: Preparer[]
  targetRate: number
  onOpenDay: (workdayId: string) => void
  onOpenPreparer: (ownerId: string) => void
}

/**
 * Bilan d'une journée d'équipe.
 *
 * Sans réseau dans l'entrepôt, les données arrivent par à-coups : cet écran doit
 * donc dire aussi clairement ce qui manque que ce qu'il montre. Un total amputé
 * de deux personnes non synchronisées se lirait sinon comme une mauvaise
 * journée.
 */
export function TeamDayView({ days, team, targetRate, onOpenDay, onOpenPreparer }: Props) {
  const dates = useMemo(() => availableDates(days), [days])
  // Par défaut la dernière journée reçue, pas la date du jour : le matin, avant
  // que quiconque ait synchronisé, celle-ci serait désespérément vide.
  const [date, setDate] = useState<string | undefined>(dates[0])
  const active = date && dates.includes(date) ? date : dates[0]

  const activeOwners = useMemo(
    () => team.filter((m) => m.active && m.userId).map((m) => m.userId!),
    [team],
  )
  const nameOf = useMemo(() => {
    const map = new Map(team.filter((m) => m.userId).map((m) => [m.userId!, m]))
    return (ownerId: string) => map.get(ownerId)?.name ?? 'Compte inconnu'
  }, [team])

  const rows = useMemo(
    () => (active ? byOwnerForDate(days, active, activeOwners) : []),
    [days, active, activeOwners],
  )
  const totals = useMemo(() => teamDayTotals(rows), [rows])
  const dayLosses = useMemo(
    () => losses(days.filter((d) => d.date === active), targetRate),
    [days, active, targetRate],
  )

  if (!active) {
    return (
      <p className="card text-sm text-slate-500">
        Aucune vacation reçue pour l'instant. Les données arrivent quand les préparateurs
        retrouvent du réseau en sortant.
      </p>
    )
  }

  const index = dates.indexOf(active)
  const stale = rows.filter((r) => r.state === 'stale')
  const missing = rows.filter((r) => r.state === 'missing')
  const rateShown = totals.rate > 0 && isRateMeaningful(totals.worked)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setDate(dates[index + 1])}
          disabled={index >= dates.length - 1}
          className="pressable rounded-xl bg-ink-700 px-4 py-2 text-sm font-bold disabled:opacity-30"
        >
          ‹ Précédent
        </button>
        <div className="text-center">
          <div className="font-bold first-letter:uppercase">{formatDayLabel(active)}</div>
          <div className="text-xs text-slate-500">
            {index === 0 ? 'dernière journée reçue' : `${index} journée(s) plus récente(s)`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDate(dates[index - 1])}
          disabled={index <= 0}
          className="pressable rounded-xl bg-ink-700 px-4 py-2 text-sm font-bold disabled:opacity-30"
        >
          Suivant ›
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Colis" value={String(totals.colis)} />
        <Kpi
          label="Cadence équipe"
          value={rateShown ? String(Math.round(totals.rate)) : '—'}
          unit={rateShown ? '/h' : undefined}
          tone={rateShown ? (totals.rate >= targetRate ? 'ok' : 'warn') : undefined}
        />
        <Kpi label="Commandes" value={String(totals.ordersCount)} />
        <Kpi label="Temps perdu" value={formatShort(totals.wasteTime)} />
      </div>

      {(missing.length > 0 || stale.length > 0) && (
        <div className="rounded-2xl border border-warn/50 bg-warn/10 p-3 text-sm">
          <p className="font-bold">Ces chiffres sont incomplets</p>
          {missing.length > 0 && (
            <p className="mt-1 text-slate-300">
              {missing.length} préparateur{missing.length > 1 ? 's' : ''} sans donnée pour
              ce jour ({missing.map((r) => nameOf(r.ownerId)).join(', ')}). Absence, ou
              synchro pas encore faite — impossible de trancher d'ici.
            </p>
          )}
          {stale.length > 0 && (
            <p className="mt-1 text-slate-300">
              {stale.length} vacation{stale.length > 1 ? 's' : ''} restée
              {stale.length > 1 ? 's' : ''} ouverte{stale.length > 1 ? 's' : ''} : le chrono
              tourne encore, la durée n'a plus de sens. Écartée des totaux.
            </p>
          )}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[0.65rem] uppercase tracking-wide text-slate-500">
              <th className="pb-2">Préparateur</th>
              <th className="pb-2 text-right">Colis</th>
              <th className="pb-2 text-right">Cadence</th>
              <th className="pb-2 text-right">Perdu</th>
              <th className="pb-2 text-right">Aléas</th>
              <th className="pb-2 text-right">État</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice()
              .sort((a, b) => b.colis - a.colis)
              .map((row) => (
                <Row
                  key={row.ownerId}
                  row={row}
                  name={nameOf(row.ownerId)}
                  targetRate={targetRate}
                  // La journée détaillée est ce qu'on veut voir depuis ce
                  // tableau ; la fiche du préparateur reste à un clic du nom.
                  onOpen={() =>
                    row.workdayId ? onOpenDay(row.workdayId) : onOpenPreparer(row.ownerId)
                  }
                  onOpenPreparer={() => onOpenPreparer(row.ownerId)}
                />
              ))}
          </tbody>
        </table>
      </div>

      {stale.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Clôturer une vacation oubliée
          </h3>
          <p className="mb-3 mt-1 text-sm text-slate-500">
            L'heure retenue est celle de la dernière activité enregistrée, pas l'heure
            actuelle — sans quoi la journée durerait quarante heures.
          </p>
          <div className="flex flex-wrap gap-2">
            {stale.map((row) => (
              <button
                key={row.ownerId}
                type="button"
                onClick={() => {
                  if (row.workdayId && row.lastActivity) {
                    void closeWorkdayAt(row.workdayId, row.lastActivity)
                  }
                }}
                className="pressable rounded-lg bg-ink-700 px-3 py-2 text-xs font-semibold"
              >
                {nameOf(row.ownerId)} → clore à{' '}
                {row.lastActivity ? hhmm(row.lastActivity) : '—'}
              </button>
            ))}
          </div>
        </div>
      )}

      {dayLosses.length > 0 && <LossTable lines={dayLosses} dayCount={1} />}

      <p className="text-xs text-slate-600">
        Les préparateurs travaillent sans réseau : leurs chiffres remontent à la sortie du
        bâtiment. Cet écran montre ce qui est arrivé, pas ce qui se passe en ce moment.
      </p>
    </div>
  )
}

const STATE_LABELS: Record<OwnerDayState, { label: string; className: string }> = {
  closed: { label: 'Journée close', className: 'text-ok' },
  open: { label: 'En cours', className: 'text-info' },
  stale: { label: 'Chrono oublié', className: 'text-bad' },
  missing: { label: 'Rien reçu', className: 'text-slate-500' },
}

function Row({
  row,
  name,
  targetRate,
  onOpen,
  onOpenPreparer,
}: {
  row: OwnerDay
  name: string
  targetRate: number
  onOpen: () => void
  onOpenPreparer: () => void
}) {
  const state = STATE_LABELS[row.state]
  const rateShown = row.countable && row.rate > 0 && isRateMeaningful(row.worked)
  const tone = !rateShown
    ? 'text-slate-600'
    : row.rate >= targetRate
      ? 'text-ok'
      : row.rate >= targetRate * 0.9
        ? 'text-warn'
        : 'text-bad'

  return (
    <tr
      onClick={onOpen}
      className={`cursor-pointer border-t border-ink-600 ${
        row.state === 'missing' ? 'opacity-50' : ''
      }`}
    >
      <td className="py-2 pr-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenPreparer()
          }}
          className="pressable text-left font-semibold underline decoration-slate-600 underline-offset-2"
        >
          {name}
        </button>
        {row.lastActivity && (
          <div className="tabular text-[0.65rem] text-slate-600">
            dernière activité {hhmm(row.lastActivity)}
          </div>
        )}
      </td>
      <td className="tabular py-2 text-right font-bold">{row.colis || '—'}</td>
      <td className={`tabular py-2 text-right font-bold ${tone}`}>
        {rateShown ? Math.round(row.rate) : '—'}
      </td>
      <td className="tabular py-2 text-right text-slate-400">
        {row.wasteTime > 0 ? formatShort(row.wasteTime) : '—'}
      </td>
      <td className="tabular py-2 text-right text-slate-400">{row.incidentCount || '—'}</td>
      <td className={`py-2 text-right text-xs font-semibold ${state.className}`}>
        {state.label}
      </td>
    </tr>
  )
}

function Kpi({
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
    <div className="card px-3 py-3">
      <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`tabular text-2xl font-bold ${
          tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : ''
        }`}
      >
        {value}
        {unit && <span className="text-sm font-semibold text-slate-500">{unit}</span>}
      </div>
    </div>
  )
}
