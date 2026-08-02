import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { incidentsByOwner, losses, performanceByOwner, type DayData } from '../core/analysis'
import { computeDayMetrics, isRateMeaningful } from '../core/metrics'
import { formatDayLabel, formatShort } from '../core/time'
import { LossTable } from '../components/LossTable'
import { TeamRanking, type RankedMember } from '../components/TeamRanking'
import { TeamTrend } from '../components/TeamTrend'
import { getSettings } from '../db/db'
import { colisEventsFor, listWorkdaysOf, loadSnapshotFor } from '../db/repo'
import { PIN_LENGTH } from '../sync/auth'
import type { Profile } from '../sync/profile'
import { addPreparer, listPreparers, resetPin, updatePreparer, type Preparer } from '../sync/team'
import { TeamDayView } from './team/TeamDayView'

interface Props {
  profile: Profile
  onOpenDay: (workdayId: string) => void
}

/**
 * Vue d'équipe, réservée aux gestionnaires.
 *
 * Les chiffres affichés proviennent de la base locale, alimentée par la
 * synchronisation : c'est la sécurité au niveau ligne, côté serveur, qui décide
 * de ce qui descend. Un préparateur qui ouvrirait cet écran n'y verrait que ses
 * propres données.
 */
export function TeamScreen({ profile, onOpenDay }: Props) {
  const [team, setTeam] = useState<Preparer[]>([])
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Preparer | undefined>()
  const [showAdd, setShowAdd] = useState(false)
  // La journée écoulée d'abord : c'est ce qu'un chef d'équipe vient chercher.
  const [view, setView] = useState<'day' | 'trends' | 'members'>('day')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setTeam(await listPreparers())
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const { days, byOwner, targetRate } = useTeamData()
  const stats = byOwner

  const ranking = useMemo<RankedMember[]>(() => {
    const byUser = new Map(team.filter((m) => m.userId).map((m) => [m.userId!, m]))
    return performanceByOwner(days)
      .map((perf) => {
        const member = byUser.get(perf.ownerId)
        return {
          ...perf,
          name: member?.name ?? 'Compte inconnu',
          badge: member?.badge ?? '—',
        }
      })
      .filter((row) => row.name !== 'Compte inconnu' || row.colis > 0)
  }, [days, team])

  const totals = useMemo(() => {
    let colis = 0
    let worked = 0
    for (const s of byOwner.values()) {
      colis += s.colis
      worked += s.worked
    }
    return {
      colis,
      worked,
      rate: worked > 0 ? colis / (worked / 3_600_000) : 0,
      vacations: days.length,
    }
  }, [byOwner, days.length])

  if (loading && team.length === 0) {
    return <p className="px-4 py-8 text-center text-slate-500">Chargement de l'équipe…</p>
  }

  const openPreparer = (ownerId: string) => {
    const member = team.find((m) => m.userId === ownerId)
    if (member) setSelected(member)
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      {error && (
        <p className="card text-sm text-bad">
          {error}
          <br />
          <span className="text-slate-500">
            La liste vient du serveur : sans réseau, elle n'est pas consultable.
          </span>
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="no-print flex gap-1.5">
          {(
            [
              { key: 'day', label: 'Journée' },
              { key: 'trends', label: 'Tendances' },
              { key: 'members', label: 'Comptes' },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              className={`pressable rounded-lg px-3 py-1.5 text-sm font-semibold ${
                view === v.key ? 'bg-accent text-black' : 'bg-ink-700 text-slate-400'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === 'day' && (
          <button
            type="button"
            onClick={() => window.print()}
            className="no-print pressable rounded-lg bg-ink-700 px-3 py-1.5 text-sm font-semibold text-slate-300"
          >
            🖨 Imprimer
          </button>
        )}
      </div>

      {view === 'day' && (
        <TeamDayView
          days={days}
          team={team}
          targetRate={targetRate}
          onOpenDay={onOpenDay}
          onOpenPreparer={openPreparer}
        />
      )}

      {view === 'trends' && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Kpi label="Colis équipe" value={String(totals.colis)} />
            <Kpi
              label="Cadence équipe"
              value={totals.rate > 0 ? String(Math.round(totals.rate)) : '—'}
              unit={totals.rate > 0 ? '/h' : undefined}
              tone={totals.rate >= targetRate ? 'ok' : 'warn'}
            />
            <Kpi label="Actifs" value={String(team.filter((m) => m.active).length)} />
            <Kpi label="Vacations" value={String(totals.vacations)} />
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <TeamRanking rows={ranking} onSelect={openPreparer} />
            <div className="flex flex-col gap-4">
              <TeamTrend days={days} targetRate={targetRate} />
              <LossTable
                lines={losses(days, targetRate)}
                dayCount={Math.max(1, days.length)}
              />
            </div>
          </div>
        </>
      )}

      {view === 'members' && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">
              Comptes <span className="text-slate-500">({team.length})</span>
            </h2>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="pressable rounded-xl bg-accent px-4 py-2 text-sm font-bold text-black"
            >
              + Ajouter
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {team.map((member) => {
          const s = stats.get(member.userId ?? '')
          const rate = s && isRateMeaningful(s.worked) ? s.colis / (s.worked / 3_600_000) : 0
          return (
            <button
              key={member.id}
              type="button"
              onClick={() => setSelected(member)}
              className={`pressable card text-left ${member.active ? '' : 'opacity-50'}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-bold">{member.name}</span>
                <span className="tabular shrink-0 text-sm text-slate-500">{member.badge}</span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {member.role === 'manager' && (
                  <Tag tone="info">gestionnaire</Tag>
                )}
                {!member.active && <Tag tone="muted">désactivé</Tag>}
                {!member.userId && <Tag tone="muted">code à définir</Tag>}
              </div>

              <div className="tabular mt-2 text-sm text-slate-400">
                {s
                  ? `${s.colis} colis · ${s.days} vacation${s.days > 1 ? 's' : ''}`
                  : 'aucune donnée reçue'}
              </div>
              {rate > 0 && (
                <div className="tabular text-2xl font-bold">
                  {Math.round(rate)}
                  <span className="text-sm text-slate-500">/h</span>
                </div>
              )}
            </button>
          )
        })}
          </div>
        </>
      )}

      {showAdd && (
        <AddPreparerDialog
          onClose={() => setShowAdd(false)}
          onDone={async () => {
            setShowAdd(false)
            await refresh()
          }}
        />
      )}

      {selected && (
        <PreparerDialog
          member={selected}
          self={profile}
          onClose={() => setSelected(undefined)}
          onChanged={refresh}
          onOpenDay={onOpenDay}
          targetRate={targetRate}
        />
      )}
    </div>
  )
}

interface OwnerStats {
  colis: number
  worked: number
  days: number
}

interface TeamData {
  /** Toutes les vacations reçues, matière première des analyses. */
  days: DayData[]
  byOwner: Map<string, OwnerStats>
  targetRate: number
}

const EMPTY_TEAM: TeamData = { days: [], byOwner: new Map(), targetRate: 110 }

/**
 * Production reçue de toute l'équipe. Ce que contient cette base est décidé par
 * la sécurité au niveau ligne côté serveur : un préparateur n'y trouverait que
 * ses propres vacations.
 */
function useTeamData(): TeamData {
  const data = useLiveQuery(async () => {
    const [workdays, settings] = await Promise.all([listWorkdaysOf(undefined, 400), getSettings()])
    const byOwner = new Map<string, OwnerStats>()
    const days: DayData[] = []

    for (const workday of workdays) {
      const [snap, events] = await Promise.all([
        loadSnapshotFor(workday),
        colisEventsFor(workday.id),
      ])
      const metrics = computeDayMetrics(snap, events, settings.targetRate)
      days.push({ id: workday.id, date: workday.date, segments: snap.segments, events, metrics })

      const key = workday.ownerId ?? ''
      const current = byOwner.get(key) ?? { colis: 0, worked: 0, days: 0 }
      current.colis += metrics.colis
      current.worked += metrics.worked
      current.days += 1
      byOwner.set(key, current)
    }

    return { days, byOwner, targetRate: settings.targetRate }
  }, [])

  return data ?? EMPTY_TEAM
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

function Tag({ children, tone }: { children: React.ReactNode; tone: 'info' | 'muted' }) {
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[0.65rem] font-bold ${
        tone === 'info' ? 'bg-info/20 text-info' : 'bg-ink-700 text-slate-500'
      }`}
    >
      {children}
    </span>
  )
}

function AddPreparerDialog({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => void
}) {
  const [badge, setBadge] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'preparer' | 'manager'>('preparer')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!/^\d{4,12}$/.test(badge)) return setError('Badge : 4 à 12 chiffres.')
    if (name.trim().length < 2) return setError('Indique un nom.')
    setBusy(true)
    const problem = await addPreparer(badge, name, role)
    setBusy(false)
    if (problem) return setError(problem)
    onDone()
  }

  return (
    <Dialog title="Ajouter un préparateur" onClose={onClose}>
      <TextField
        label="Numéro de badge"
        value={badge}
        onChange={(v) => setBadge(v.replace(/\D/g, ''))}
        placeholder="1234567"
      />
      <TextField label="Nom" value={name} onChange={setName} placeholder="Prénom Nom" />

      <div className="grid grid-cols-2 gap-2">
        {(['preparer', 'manager'] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            className={`pressable rounded-xl py-3 text-sm font-bold ${
              role === r ? 'bg-info text-black' : 'bg-ink-700 text-slate-300'
            }`}
          >
            {r === 'preparer' ? 'Préparateur' : 'Gestionnaire'}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-500">
        Le code personnel n'est pas défini ici : la personne le choisira elle-même à sa
        première connexion.
      </p>

      {error && <p className="text-sm text-bad">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="pressable min-h-touch rounded-xl bg-accent font-bold text-black disabled:opacity-40"
      >
        {busy ? 'Ajout…' : 'Ajouter'}
      </button>
    </Dialog>
  )
}

function PreparerDialog({
  member,
  self,
  onClose,
  onChanged,
  onOpenDay,
  targetRate,
}: {
  member: Preparer
  self: Profile
  onClose: () => void
  onChanged: () => Promise<void>
  onOpenDay: (workdayId: string) => void
  targetRate: number
}) {
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [newPin, setNewPin] = useState('')
  const [busy, setBusy] = useState(false)
  const isSelf = member.userId === self.userId

  const days = useLiveQuery(async () => {
    if (!member.userId) return []
    const [workdays, settings] = await Promise.all([
      listWorkdaysOf(member.userId, 30),
      getSettings(),
    ])
    return Promise.all(
      workdays.map(async (workday) => {
        const [snap, events] = await Promise.all([
          loadSnapshotFor(workday),
          colisEventsFor(workday.id),
        ])
        return {
          id: workday.id,
          date: workday.date,
          // Segments et comptages inclus : le relevé des aléas subis en a besoin.
          segments: snap.segments,
          events,
          metrics: computeDayMetrics(snap, events, settings.targetRate),
        }
      }),
    )
  }, [member.userId])

  const sorted = useMemo(() => days ?? [], [days])

  const incidents = useMemo(() => {
    if (!member.userId || sorted.length === 0) return []
    return incidentsByOwner(sorted, targetRate).get(member.userId) ?? []
  }, [sorted, member.userId, targetRate])

  async function run(action: () => Promise<string | undefined>, ok: string) {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    const problem = await action()
    setBusy(false)
    if (problem) return setError(problem)
    setMessage(ok)
    await onChanged()
  }

  return (
    <Dialog title={`${member.name} — ${member.badge}`} onClose={onClose}>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || isSelf}
          onClick={() =>
            run(
              () => updatePreparer(member.id, { active: !member.active }),
              member.active ? 'Compte désactivé.' : 'Compte réactivé.',
            )
          }
          className="pressable rounded-xl bg-ink-700 px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
        >
          {member.active ? 'Désactiver' : 'Réactiver'}
        </button>

        <button
          type="button"
          disabled={busy || isSelf}
          onClick={() =>
            run(
              () =>
                updatePreparer(member.id, {
                  role: member.role === 'manager' ? 'preparer' : 'manager',
                }),
              'Rôle modifié.',
            )
          }
          className="pressable rounded-xl bg-ink-700 px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
        >
          {member.role === 'manager' ? 'Retirer gestionnaire' : 'Passer gestionnaire'}
        </button>
      </div>

      {isSelf && (
        <p className="text-xs text-slate-500">
          Tu ne peux pas modifier ton propre rôle ni te désactiver : c'est ce qui évite de
          se retrouver sans aucun gestionnaire.
        </p>
      )}

      {member.userId && (
        <div className="flex flex-col gap-2 rounded-xl border border-ink-600 p-3">
          <span className="text-sm font-semibold text-slate-400">
            Réinitialiser le code personnel
          </span>
          <input
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
            placeholder={`${PIN_LENGTH} chiffres`}
            inputMode="numeric"
            className="rounded-xl border border-ink-600 bg-ink-900 px-3 py-2.5"
          />
          <button
            type="button"
            disabled={busy || newPin.length !== PIN_LENGTH}
            onClick={() =>
              run(() => resetPin(member.id, newPin), 'Code redéfini. Communique-le en main propre.')
            }
            className="pressable rounded-xl bg-ink-700 py-2.5 text-sm font-semibold disabled:opacity-40"
          >
            Définir ce code
          </button>
        </div>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
      {message && <p className="text-sm text-ok">{message}</p>}

      {incidents.length > 0 && (
        <div className="rounded-xl border border-ink-600 p-3">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Aléas subis
          </h4>
          <p className="mb-2 mt-1 text-xs text-slate-500">
            Du temps qui ne dépend pas de lui. Un motif qui revient signale plutôt un
            problème de poste ou de matériel qu'un problème de rythme.
          </p>
          <ul className="flex flex-col gap-1.5">
            {incidents.map((line) => (
              <li key={line.type} className="flex items-baseline gap-2 text-sm">
                <span>{line.emoji}</span>
                <span className="flex-1 truncate">
                  {line.label}
                  <span className="ml-1 text-slate-600">×{line.count}</span>
                </span>
                <span className="tabular font-semibold">{formatShort(line.time)}</span>
                <span className="tabular w-16 text-right text-slate-500">
                  {Math.round(line.colisEquivalent)} col.
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Vacations reçues
        </h4>
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-600">
            Aucune donnée reçue pour ce préparateur.
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {sorted.map((day) => {
              const shown = isRateMeaningful(day.metrics.worked)
              return (
                <li key={day.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onOpenDay(day.id)
                    }}
                    className="pressable flex w-full items-center justify-between rounded-xl bg-ink-700 px-3 py-2 text-left text-sm"
                  >
                    <span className="first-letter:uppercase">{formatDayLabel(day.date)}</span>
                    <span className="tabular text-slate-400">
                      {day.metrics.colis} colis · {formatShort(day.metrics.presence)}
                      {shown && ` · ${Math.round(day.metrics.rates.day)}/h`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Dialog>
  )
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 md:items-center">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-2xl border border-ink-600 bg-ink-800 p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-bold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="pressable rounded-lg bg-ink-700 px-3 py-1.5 text-sm font-semibold text-slate-400"
          >
            Fermer
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="none"
        className="rounded-xl border border-ink-600 bg-ink-900 px-3 py-3"
      />
    </label>
  )
}
