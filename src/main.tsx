import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import {
  flushDurableBackup,
  recoverDurableBackup,
  startDurableBackupProtection,
} from './native/durableStorage'
import { recoverOrphanedWorkdays } from './db/recovery'

async function start() {
  await recoverDurableBackup()
  await recoverOrphanedWorkdays()
  // Crée immédiatement le filet natif pour les installations existantes,
  // avant même le prochain appui utilisateur.
  await flushDurableBackup()
  startDurableBackupProtection()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void start()
