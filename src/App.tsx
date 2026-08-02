import { useState } from 'react'
import { useAlerts } from './hooks/useAlerts'
import { DESKTOP_QUERY, useMediaQuery } from './hooks/useMediaQuery'
import { useSession } from './hooks/useSession'
import { useSync } from './hooks/useSync'
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
  const alerts = useAlerts(session.view.active, session.settings, session.now)

  const isManager = sync.profile?.role === 'manager'
  const tabs = TABS.filter((t) => !t.manager || isManager)
  // Le rôle arrive après le chargement du profil : un gestionnaire rétrogradé,
  // ou un préparateur affiché un instant avec l'onglet Équipe, ne doit pas
  // rester bloqué sur un écran qui ne le concerne plus.
  const activeTab: Tab = tabs.some((t) => t.key === tab) ? tab : 'today'

  // Le bilan reste dans le cadre de l'application plutôt que de s'ouvrir en
  // plein écran : sur PC, perdre la navigation pour consulter une journée
  // donnerait l'impression d'avoir changé de site.
  const content = reportId ? (
    <DayReportScreen workdayId={reportId} onBack={() => setReportId(undefined)} />
  ) : (
    <>
      {alerts.length > 0 && (
        <div className="sticky top-0 z-40 px-4 pb-2 pt-2">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`mb-2 rounded-xl px-4 py-3 ${
                alert.kind === 'break_end' ? 'bg-warn text-black' : 'bg-bad text-white'
              }`}
            >
              <div className="font-bold">{alert.title}</div>
              <div className="text-sm opacity-90">{alert.detail}</div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'today' && (
        <TodayScreen
          session={session}
          desktop={isDesktop}
          onShowReport={() => {
            if (session.snap.workday) setReportId(session.snap.workday.id)
          }}
        />
      )}

      {activeTab === 'stats' && <DashboardScreen onOpen={setReportId} />}

      {activeTab === 'team' && sync.profile && (
        <TeamScreen profile={sync.profile} onOpenDay={setReportId} />
      )}

      {activeTab === 'settings' && (
        <div className="mx-auto w-full max-w-2xl">
          <SettingsScreen sync={sync} />
        </div>
      )}
    </>
  )

  return (
    // Marge haute : même en `status-bar-style: black`, iOS laisse la page
    // démarrer sous l'heure et la Dynamic Island en mode « app web ». Sans elle,
    // le premier bloc est amputé.
    //
    // Elle est comprise dans la hauteur minimale (`border-box`) : elle ne rend
    // donc pas la page plus haute que la fenêtre, et ne réintroduit pas de
    // défilement.
    <div
      className="app-shell flex"
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
              {item.key === 'settings' && sync.configured && sync.pending > 0 && (
                <span className="tabular ml-auto rounded-full bg-slate-600 px-1.5 text-[0.65rem] font-bold text-slate-100">
                  {sync.pending > 99 ? '99+' : sync.pending}
                </span>
              )}
            </button>
          ))}
        </nav>

        <SidebarStatus session={session} sync={sync} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex flex-1 flex-col">{content}</main>

        {/* Barre d'onglets réservée au téléphone. */}
        {/* `safe-bottom` ici et nulle part ailleurs : le fond de la barre
            s'étend ainsi jusqu'au bord de l'écran, sous la barre d'accueil,
            au lieu de laisser un bandeau nu en dessous. */}
        {/* `sticky bottom-0` : c'est le navigateur qui pose la barre sur le bord
            visible réel. Toute tentative de la placer nous-mêmes, à partir d'une
            hauteur calculée, la décale en mode « app web ». */}
        <nav className="safe-bottom sticky bottom-0 z-30 mt-auto flex shrink-0 border-t border-ink-600 bg-ink-800 md:hidden">
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
              {item.key === 'settings' && sync.configured && sync.pending > 0 && (
                <span className="tabular absolute right-[22%] top-1 rounded-full bg-slate-600 px-1.5 text-[0.6rem] font-bold text-slate-100">
                  {sync.pending > 99 ? '99+' : sync.pending}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>
    </div>
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
        {!sync.configured
          ? 'Synchro non configurée'
          : !sync.profile
            ? 'Non connecté'
            : sync.pending > 0
              ? `${sync.pending} en attente d'envoi`
              : sync.lastSyncAt
                ? `Synchro à ${hhmm(sync.lastSyncAt)}`
                : 'Synchronisé'}
      </div>
    </div>
  )
}
