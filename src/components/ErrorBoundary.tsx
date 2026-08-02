import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error?: Error
}

/**
 * Filet de sécurité. À l'entrepôt il n'y a ni réseau ni console : un écran noir
 * en pleine vacation signifierait une journée de suivi perdue. En cas de plantage
 * on affiche donc un message lisible, on rappelle que les données déjà
 * enregistrées sont intactes en base, et on propose de recharger.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('PrepaTrack — erreur non rattrapée', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-5xl">⚠️</div>
        <h1 className="text-xl font-bold">L'affichage a planté</h1>
        <p className="max-w-sm text-slate-400">
          Tes données sont enregistrées et intactes : rien n'est perdu. Recharge l'app pour
          reprendre là où tu en étais.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="pressable min-h-touch w-full max-w-sm rounded-2xl bg-accent px-4 text-xl font-bold text-black"
        >
          Recharger
        </button>
        <pre className="max-w-full overflow-x-auto rounded-xl bg-ink-800 p-3 text-left text-xs text-slate-500">
          {this.state.error.message}
        </pre>
      </div>
    )
  }
}
