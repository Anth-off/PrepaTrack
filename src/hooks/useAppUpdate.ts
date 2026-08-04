import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { appUpdatePolicy } from '../core/appUpdate'

export interface AppVersionInfo {
  version: string
  buildTime: string
}

interface WorkerSnapshot {
  ready: boolean
  installing: boolean
  offlineReady: boolean
  registered: boolean
  available?: AppVersionInfo
  lastError?: string
}

export interface AppUpdateControl extends WorkerSnapshot {
  installed: AppVersionInfo
  online: boolean
  notice: 'hidden' | 'deferred' | 'actionable'
  activationAllowed: boolean
  install: () => Promise<void>
}

const installed: AppVersionInfo = {
  version: __APP_VERSION__,
  buildTime: __BUILD_TIME__,
}

let workerSnapshot: WorkerSnapshot = {
  ready: false,
  installing: false,
  offlineReady: false,
  registered: false,
}
let started = false
let registration: ServiceWorkerRegistration | undefined
let activateWaitingWorker: (() => Promise<void>) | undefined
const listeners = new Set<() => void>()

function publish(patch: Partial<WorkerSnapshot>) {
  workerSnapshot = { ...workerSnapshot, ...patch }
  listeners.forEach((listener) => listener())
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readAvailableVersion() {
  try {
    const url = new URL('version.json', document.baseURI)
    url.searchParams.set('t', String(Date.now()))
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) return
    const value = (await response.json()) as Partial<AppVersionInfo>
    if (typeof value.version === 'string' && typeof value.buildTime === 'string') {
      publish({ available: { version: value.version, buildTime: value.buildTime } })
    }
  } catch {
    // La version est déjà téléchargée par Workbox. L'échec de ce petit fichier
    // informatif ne doit ni masquer la mise à jour ni gêner le travail hors ligne.
  }
}

function checkForUpdate() {
  if (!navigator.onLine || document.visibilityState === 'hidden') return
  void registration
    ?.update()
    .then(() => publish({ lastError: undefined }))
    .catch((error: unknown) => {
      publish({ lastError: errorText(error) })
    })
}

function startServiceWorker() {
  if (started) return
  started = true

  activateWaitingWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      publish({ ready: true, lastError: undefined })
      void readAvailableVersion()
    },
    onOfflineReady() {
      publish({ offlineReady: true })
    },
    onRegisteredSW(_scriptUrl, value) {
      registration = value
      publish({ registered: value !== undefined })
      checkForUpdate()
    },
    onRegisterError(error) {
      // Une erreur réseau/service worker reste un diagnostic : l'application et
      // ses données IndexedDB continuent de fonctionner avec la version active.
      publish({ lastError: errorText(error) })
    },
  })

  window.setInterval(checkForUpdate, 60 * 60 * 1_000)
  window.addEventListener('online', checkForUpdate)
  window.addEventListener('focus', checkForUpdate)
  document.addEventListener('visibilitychange', checkForUpdate)

  // Le module vit aussi longtemps que l'application. Conserver ces écouteurs
  // évite de réenregistrer Workbox à chaque changement d'écran.
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return workerSnapshot
}

async function installReadyUpdate() {
  if (!workerSnapshot.ready || workerSnapshot.installing || !activateWaitingWorker) return
  publish({ installing: true, lastError: undefined })
  try {
    // En mode `prompt`, c'est le seul endroit qui envoie SKIP_WAITING. Workbox
    // recharge ensuite une seule fois lorsque le nouveau worker prend le contrôle.
    await activateWaitingWorker()
  } catch (error) {
    publish({ installing: false, lastError: errorText(error) })
  }
}

/** État global de la mise à jour, avec verrou métier sur la vacation courante. */
export function useAppUpdate(workdayActive: boolean): AppUpdateControl {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    startServiceWorker()
  }, [])

  useEffect(() => {
    const read = () => setOnline(navigator.onLine)
    window.addEventListener('online', read)
    window.addEventListener('offline', read)
    return () => {
      window.removeEventListener('online', read)
      window.removeEventListener('offline', read)
    }
  }, [])

  const policy = appUpdatePolicy({ updateReady: state.ready, workdayActive, online })
  const install = useCallback(async () => {
    // Deuxième garde au moment exact du clic : un écran rendu juste avant
    // l'ouverture d'une vacation ne doit jamais pouvoir activer la mise à jour.
    const currentPolicy = appUpdatePolicy({
      updateReady: workerSnapshot.ready,
      workdayActive,
      online,
    })
    if (!currentPolicy.activationAllowed) {
      return
    }
    await installReadyUpdate()
  }, [online, workdayActive])

  return {
    ...state,
    installed,
    online,
    notice: policy.notice,
    activationAllowed: policy.activationAllowed,
    install,
  }
}
