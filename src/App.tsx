import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useAlerts } from './hooks/useAlerts'
import { useCartMotion } from './hooks/useCartMotion'
import { AppUpdateNotice } from './components/AppUpdateNotice'
import { SyncStatusBadge } from './components/SyncStatusBadge'
import { useAppUpdate } from './hooks/useAppUpdate'
import { DESKTOP_QUERY, useMediaQuery } from './hooks/useMediaQuery'
import { useSession } from './hooks/useSession'
import { useResumePrompt } from './hooks/useResumePrompt'
import { useSync } from './hooks/useSync'
import { useRecording } from './hooks/useRecording'
import { formatShort, hhmm } from './core/time'
import { DashboardScreen } from './screens/DashboardScreen'
import { DayReportScreen } from './screens/DayReportScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { TeamScreen } from './screens/TeamScreen'
import { TodayScreen } from './screens/TodayScreen'

type Tab = 'today' | 'stats' | 'team' | 'settings'

interface TabDef {
  key: Tab
  label: string
  short?: string
  emoji: string
  /** Onglet réservé aux gestionnaires. */
  manager?: boolean
}

const TABS: TabDef[] = [
  { key: 'today', label: 'Journée', emoji: '⏱' },
  { key: 'stats', label: 'Statistiques', short: 'Stats', emoji: '📊' },
  { key: 'team', label: 'Équipe', emoji: '👥', manager: true },
  { key: 'settings', label: 'Réglages', emoji: '⚙️' },
]

export default function App() {
  const session = useSession()
  // Tant que la base n'est pas chargée, on choisit le cas sûr : une vacation
  // pourrait être ouverte et aucune mise à jour ne doit alors être activable.
  const appUpdate = useAppUpdate(session.loading || Boolean(session.snap.workday))
  const resume = useResumePrompt(session)
  const cartMotion = useCartMotion(session)
  const recording = useRecording(
    session.snap.workday?.id,
    session.settings.recording.enabled,
    session.settings.recording.retentionDays,
  )
  const sync = useSync()
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  // Sur grand écran on arrive sur les statistiques : le PC sert à consulter le
  // soir, pas à chronométrer une vacation.
  const [tab, setTab] = useState<Tab>(() =>
    typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches
      ? 'stats'
      : 'today',
  )
  const [reportId, setReportId] = useState<string | undefined>()
  const [reportSegmentId, setReportSegmentId] = useState<string | undefined>()
  const alerts = useAlerts(session.view.active, session.settings, session.now)

  const isManager = sync.profile?.role === 'manager'
  const tabs = TABS.filter((t) => !t.manager || isManager)
  // Le rôle arrive après le chargement du profil : un gestionnaire rétrogradé,
  // ou un préparateur affiché un instant avec l'onglet Équipe, ne doit pas
  // rester bloqué sur un écran qui ne le concerne plus.
  const activeTab: Tab = tabs.some((t) => t.key === tab) ? tab : 'today'
  const isTodayScreen = activeTab === 'today' && !reportId

  // Le bilan reste dans le cadre de l'application plutôt que de s'ouvrir en
  // plein écran : sur PC, perdre la navigation pour consulter une journée
  // donnerait l'impression d'avoir changé de site.
  const content = reportId ? (
    <DayReportScreen
      workdayId={reportId}
      initialSegmentId={reportSegmentId}
      onBack={() => {
        setReportId(undefined)
        setReportSegmentId(undefined)
      }}
    />
  ) : (
    <>
      {alerts.length > 0 && (
        <div
          className={
            isTodayScreen
              ? 'pointer-events-none absolute left-0 right-0 top-0 z-40 px-4 pt-2'
              : 'sticky top-0 z-40 px-4 pb-2 pt-2'
          }
        >
          {alerts.map((alert) => {
            const className = `mb-2 w-full rounded-xl px-4 py-3 text-left ${
              alert.kind === 'break_end' ? 'bg-warn text-black' : 'bg-bad text-white'
            }`
            const body = (
              <>
                <div className="font-bold">{alert.title}</div>
                <div className="text-sm opacity-90">{alert.detail}</div>
              </>
            )
            return alert.kind === 'stuck' && session.snap.workday ? (
              <button
                key={alert.id}
                type="button"
                className={`pressable pointer-events-auto ${className}`}
                onClick={() => {
                  setReportSegmentId(session.view.active?.id)
                  setReportId(session.snap.workday!.id)
                }}
              >
                {body}
              </button>
            ) : (
              <div key={alert.id} className={className}>{body}</div>
            )
          })}
        </div>
      )}

      {activeTab === 'today' && (
        <TodayScreen
          session={session}
          resume={resume}
          desktop={isDesktop}
          onShowReport={() => {
            setReportSegmentId(undefined)
            if (session.snap.workday) setReportId(session.snap.workday.id)
          }}
        />
      )}

      {activeTab === 'stats' && <DashboardScreen onOpen={(id) => {
        setReportSegmentId(undefined)
        setReportId(id)
      }} />}

      {activeTab === 'team' && sync.profile && (
        <TeamScreen profile={sync.profile} onOpenDay={(id) => {
          setReportSegmentId(undefined)
          setReportId(id)
        }} />
      )}

      {activeTab === 'settings' && (
        <div className="mx-auto w-full max-w-2xl">
          <SettingsScreen sync={sync} motion={cartMotion} recording={recording} update={appUpdate} />
        </div>
      )}
    </>
  )

  return (
    <>
      <AppUpdateNotice update={appUpdate} />
      {/* La marge haute reste sur la coque fixe : le contenu ne peut ainsi jamais
          passer sous l'heure ou la Dynamic Island pendant un défilement. */}
      <div
        className={`app-shell flex bg-ink-900 ${Capacitor.getPlatform() === 'ios' ? 'native-ios' : ''}`}
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
      {/* Barre latérale : la navigation d'une application de bureau se tient à
          gauche, pas au pouce en bas de l'écran. */}
      <aside className="sticky top-0 hidden h-full max-h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-ink-600 bg-ink-800 px-3 py-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="text-2xl">📦</span>
          <span className="text-lg font-bold">PrepaTrack</span>
        </div>

        <nav className="flex flex-col gap-1">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setReportId(undefined)
                setTab(item.key)
              }}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                activeTab === item.key
                  ? 'bg-accent text-black'
                  : 'text-slate-400 hover:bg-ink-700 hover:text-slate-100'
              }`}
            >
              <span className="text-lg leading-none">{item.emoji}</span>
              {item.label}
              {item.key === 'settings' && (
                <span className="ml-auto"><SyncStatusBadge status={sync.status} compact /></span>
              )}
              {item.key === 'settings' && sync.configured && sync.pending > 0 && (
                <span className="tabular rounded-full bg-slate-600 px-1.5 text-[0.65rem] font-bold text-slate-100">
                  {sync.pending > 99 ? '99+' : sync.pending}
                </span>
              )}
            </button>
          ))}
        </nav>

        <SidebarStatus session={session} sync={sync} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Zone de contenu bornée. Journée ne défile jamais ; les écrans de
            consultation conservent leur défilement interne. `min-h-0` permet
            dans les deux cas au contenu de respecter la hauteur de la coque. */}
        <main
          data-screen={isTodayScreen ? 'today' : reportId ? 'report' : activeTab}
          className={`relative flex min-h-0 flex-1 flex-col ${
            isTodayScreen
              ? 'overflow-hidden'
              : 'overflow-y-auto overscroll-contain'
          }`}
        >
          {content}
        </main>

        {/* Barre d'onglets réservée au téléphone. */}
        {/* `safe-bottom` ici et nulle part ailleurs : le fond de la barre
            s'étend ainsi jusqu'au bord de l'écran, sous la barre d'accueil,
            au lieu de laisser un bandeau nu en dessous. */}
        {/* Ni `sticky` ni `fixed` : la coque fait exactement la hauteur de la
            fenêtre et ne défile pas, donc la barre est déjà à sa place. Un
            `sticky bottom-0` ne se recalait que pendant un défilement actif —
            d'où une barre correcte le doigt posé, et remontée au relâchement. */}
        <nav className="safe-bottom z-30 flex shrink-0 border-t border-ink-600 bg-ink-800 md:hidden">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setReportId(undefined)
                setTab(item.key)
              }}
              className={`relative flex flex-1 flex-col items-center gap-0.5 pb-1 pt-1.5 text-[0.65rem] font-bold uppercase tracking-wide ${
                activeTab === item.key ? 'text-accent' : 'text-slate-500'
              }`}
            >
              <span className="text-xl leading-none">{item.emoji}</span>
              {item.short ?? item.label}
              {item.key === 'settings' && (
                <span className="absolute right-[25%] top-1"><SyncStatusBadge status={sync.status} compact /></span>
              )}
              {item.key === 'settings' && sync.configured && sync.pending > 0 && (
                <span className="tabular absolute right-[10%] top-1 rounded-full bg-slate-600 px-1.5 text-[0.6rem] font-bold text-slate-100">
                  {sync.pending > 99 ? '99+' : sync.pending}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>
      </div>
    </>
  )
}

/** Pied de la barre latérale : état de la vacation et de la synchro. */
function SidebarStatus({
  session,
  sync,
}: {
  session: ReturnType<typeof useSession>
  sync: ReturnType<typeof useSync>
}) {
  const { view, day } = session

  return (
    <div className="mt-auto flex flex-col gap-3 px-2 text-xs">
      {view.phase !== 'no_day' && (
        <div className="rounded-xl bg-ink-700 p-3">
          <div className="font-bold text-accent">Vacation en cours</div>
          <div className="tabular mt-1 text-slate-400">
            depuis {hhmm(day.startedAt)} · {formatShort(day.presence)}
          </div>
          <div className="tabular text-slate-400">
            {day.colis} colis · {day.ordersCount} commande{day.ordersCount > 1 ? 's' : ''}
          </div>
        </div>
      )}

      <div className="text-slate-600">
        {sync.profile && (
          <div className="mb-1 font-semibold text-slate-400">
            {sync.profile.name} · {sync.profile.badge}
          </div>
        )}
        <SyncStatusBadge status={sync.status} />
        {sync.lastSyncAt && sync.status.state === 'up-to-date' && (
          <div className="tabular mt-1">Dernière réussite à {hhmm(sync.lastSyncAt)}</div>
        )}
      </div>
    </div>
  )
}
