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
  // Chaque filet de récupération reste indépendant. Une copie native abîmée
  // ou une ligne historique inattendue ne doit jamais produire un écran noir
  // qui empêcherait l'utilisateur d'accéder aux données encore lisibles.
  try { await recoverDurableBackup() } catch { /* IndexedDB reste prioritaire. */ }
  try { await recoverOrphanedWorkdays() } catch { /* L'application doit démarrer malgré tout. */ }
  // Crée immédiatement le filet natif pour les installations existantes,
  // avant même le prochain appui utilisateur.
  try { await flushDurableBackup() } catch { /* Le filet périodique réessaiera. */ }
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
