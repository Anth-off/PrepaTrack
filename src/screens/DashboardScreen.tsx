import { useMemo, useState } from 'react'
import { BucketChart } from '../components/BucketChart'
import { DayBars } from '../components/DayBars'
import { DayList } from '../components/DayList'
import { HourChart } from '../components/HourChart'
import { LossTable } from '../components/LossTable'
import { RateCards } from '../components/RateCards'
import { RecoList } from '../components/RecoList'
import { TimeBreakdown } from '../components/TimeBreakdown'
import { byDensity, byHour, byOrderType, bySupport, byWeekday, losses } from '../core/analysis'
import { recommend } from '../core/recommendations'
import { formatDayLabel, formatShort } from '../core/time'
import { useRecentDays } from '../hooks/useRecentDays'
import { useNow } from '../hooks/useNow'
import { closeWorkdayAt, plausibleEndFor } from '../db/repo'

interface Props {
  onOpen: (workdayId: string) => void
}

const PERIODS = [
  { key: 7, label: '7 jours' },
  { key: 30, label: '30 jours' },
  { key: 365, label: 'Tout' },
] as const

/**
 * Vue de synthèse. Même contenu sur les deux écrans, dense en colonnes sur PC
 * et empilé sur téléphone : le besoin d'information est le même le soir et
 * pendant une pause, seule la place disponible change.
 */
export function DashboardScreen({ onOpen }: Props) {
  const [period, setPeriod] = useState<number>(30)
  const now = useNow(60_000)
  const { days: allDays, targetRate, loading } = useRecentDays(365)

  const inPeriod = useMemo(() => {
    if (period >= 365) return allDays
    const limit = now - period * 24 * 3600_000
    return allDays.filter((d) => d.metrics.startedAt >= limit)
  }, [allDays, now, period])

  // Une vacation oubliée ouverte compte des heures de présence fictives : la
  // laisser dans les moyennes ferait passer une bonne semaine pour une mauvaise.
  const days = useMemo(() => inPeriod.filter((d) => !d.stale), [inPeriod])
  const stale = useMemo(() => inPeriod.filter((d) => d.stale), [inPeriod])

  const analysis = useMemo(
    () => ({
      recommendations: recommend({ days, targetRate }),
      hours: byHour(days),
      types: byOrderType(days),
      density: byDensity(days),
      supports: bySupport(days),
      weekdays: byWeekday(days),
      lost: losses(days, targetRate),
    }),
    [days, targetRate],
  )

  async function closeStale(workdayId: string) {
    const end = await plausibleEndFor(workdayId)
    // Sans aucun segment terminé, il n'y a rien de plausible à proposer : mieux
    // vaut renvoyer vers la correction manuelle que d'inventer une heure.
    if (end === undefined) return onOpen(workdayId)
    await closeWorkdayAt(workdayId, end)
  }

  if (loading) return <p className="px-4 py-8 text-center text-slate-500">Chargement…</p>

  if (allDays.length === 0) {
    return (
      <p className="px-4 py-16 text-center text-slate-500">
        Aucune journée enregistrée pour l'instant.
      </p>
    )
  }

  const last = days[0] ?? allDays[0]
  const totals = days.reduce(
    (acc, d) => ({
      colis: acc.colis + d.metrics.colis,
      orders: acc.orders + d.metrics.ordersCount,
      worked: acc.worked + d.metrics.worked,
      waste: acc.waste + d.metrics.wasteTime,
      overtime: acc.overtime + d.metrics.overtime,
    }),
    { colis: 0, orders: 0, worked: 0, waste: 0, overtime: 0 },
  )
  const averageRate = totals.worked > 0 ? totals.colis / (totals.worked / 3_600_000) : 0

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 md:px-6 md:py-6">
      <div className="flex gap-1.5">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPeriod(p.key)}
            className={`pressable rounded-lg px-3 py-1.5 text-sm font-semibold ${
              period === p.key ? 'bg-accent text-black' : 'bg-ink-700 text-slate-400'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {stale.length > 0 && (
        <div className="rounded-2xl border border-warn/50 bg-warn/10 p-3">
          <p className="text-sm font-bold">
            {stale.length} journée{stale.length > 1 ? 's' : ''} restée
            {stale.length > 1 ? 's' : ''} ouverte{stale.length > 1 ? 's' : ''}
          </p>
          <p className="mt-1 text-sm text-slate-300">
            Le chrono y tourne encore, la durée n'a plus de sens : ces journées sont
            écartées des moyennes ci-dessous.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {stale.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpen(d.id)}
                  className="pressable rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-semibold first-letter:uppercase"
                >
                  {formatDayLabel(d.date)} · {formatShort(d.metrics.presence)} ›
                </button>
                <button
                  type="button"
                  onClick={() => void closeStale(d.id)}
                  className="pressable rounded-lg bg-warn px-3 py-1.5 text-xs font-bold text-black"
                >
                  Clôturer au dernier pointage
                </button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            La clôture reprend l'heure du dernier chrono terminé, pas l'heure actuelle.
            Tu pourras l'ajuster ensuite depuis le tracé de la journée.
          </p>
        </div>
      )}

      {/* Deux colonnes dès 768 px : avec l'affichage Windows à 125 ou 150 %, un
          écran de portable descend souvent sous les 1024 px de largeur CSS et
          resterait bloqué en présentation téléphone. */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Colis cumulés" value={String(totals.colis)} />
        <Kpi
          label="Cadence moyenne"
          value={averageRate > 0 ? String(Math.round(averageRate)) : '—'}
          unit={averageRate > 0 ? '/h' : undefined}
          tone={averageRate >= targetRate ? 'ok' : 'warn'}
        />
        <Kpi label="Commandes" value={String(totals.orders)} />
        <Kpi label="Temps perdu" value={formatShort(totals.waste)} />
        <Kpi label="Heures supp" value={formatShort(totals.overtime)} />
      </div>

      {days.length === 0 ? (
        <p className="card text-sm text-slate-500">
          Aucune vacation sur cette période. Choisis une plage plus large.
        </p>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="flex flex-col gap-4 xl:col-span-2">
            <RecoList recommendations={analysis.recommendations} dayCount={days.length} />
            <DayBars days={days} targetRate={targetRate} onSelect={onOpen} />
            <HourChart points={analysis.hours} targetRate={targetRate} />

            <section>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                Journées
              </h3>
              <DayList days={days} targetRate={targetRate} onOpen={onOpen} />
            </section>
          </div>

          <div className="flex flex-col gap-4">
            <section>
              <button
                type="button"
                onClick={() => onOpen(last.id)}
                className="pressable mb-2 flex w-full items-baseline justify-between text-left"
              >
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Dernière journée
                </h3>
                <span className="text-xs text-slate-500 first-letter:uppercase">
                  {formatDayLabel(last.date)} ›
                </span>
              </button>
              <RateCards day={last.metrics} targetRate={targetRate} />
            </section>

            <LossTable lines={analysis.lost} dayCount={days.length} />
            <TimeBreakdown day={last.metrics} />

            <BucketChart
              title="Selon la densité de la commande"
              buckets={analysis.density}
              targetRate={targetRate}
              empty="Renseigne le nombre de lignes au lancement des commandes pour voir cet écart."
            />
            <BucketChart
              title="Par type de commande"
              buckets={analysis.types}
              targetRate={targetRate}
            />
            <BucketChart
              title="Par support dominant"
              buckets={analysis.supports}
              targetRate={targetRate}
            />
            <BucketChart
              title="Par jour de la semaine"
              buckets={analysis.weekdays}
              targetRate={targetRate}
              empty="Il faut plusieurs vacations pour comparer les jours."
            />
          </div>
        </div>
      )}
    </div>
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
