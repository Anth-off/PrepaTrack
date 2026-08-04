import { useEffect, useState } from 'react'
import type { AppUpdateControl, AppVersionInfo } from '../hooks/useAppUpdate'

declare const __BUILD_TIME__: string

interface Info {
  build: string
  affichage: string
  ecran: string
  fenetre: string
  marges: string
  hauteur: string
  chevauche: string
  barre: string
}

/**
 * Diagnostic d'affichage.
 *
 * Un défaut de mise en page sur un iPhone précis est invisible depuis un poste
 * de développement : les marges réservées à l'encoche et à la barre d'accueil
 * n'existent que sur l'appareil. Ces quelques valeurs, lisibles et recopiables,
 * évitent de procéder par essais successifs à l'aveugle.
 */
export function DiagnosticSection({ update }: { update: AppUpdateControl }) {
  const [info, setInfo] = useState<Info | undefined>()
  const [copied, setCopied] = useState(false)
  const [debug, setDebug] = useState(false)

  useEffect(() => {
    const read = () => {
      const probe = document.createElement('div')
      probe.style.cssText =
        'position:fixed;top:0;left:0;visibility:hidden;' +
        'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);' +
        'padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)'
      document.body.appendChild(probe)
      const cs = getComputedStyle(probe)
      const top = parseFloat(cs.paddingTop) || 0
      const bottom = parseFloat(cs.paddingBottom) || 0
      const left = parseFloat(cs.paddingLeft) || 0
      const right = parseFloat(cs.paddingRight) || 0
      probe.remove()

      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true

      setInfo({
        build: new Date(__BUILD_TIME__).toLocaleString('fr-FR'),
        affichage: standalone ? 'app installée' : 'onglet Safari',
        ecran: `${window.screen.width}×${window.screen.height}`,
        fenetre: `${window.innerWidth}×${window.innerHeight}`,
        marges: `haut ${top} · bas ${bottom} · gauche ${left} · droite ${right}`,
        // Un écart entre la coquille et la fenêtre trahit une hauteur mal
        // évaluée : c'est ce qui donne un affichage décalé jusqu'au premier
        // défilement.
        hauteur: (() => {
          const shell = document.querySelector('.app-shell')
          const real = shell ? Math.round(shell.getBoundingClientRect().height) : 0
          const html = Math.round(document.documentElement.getBoundingClientRect().height)
          // Ces trois valeurs doivent coïncider. Un écart signale une hauteur
          // mal propagée, c'est-à-dire un affichage décalé.
          return `app ${real} · page ${html} · fenêtre ${window.innerHeight}`
        })(),
        // Si la page dépasse la fenêtre, c'est qu'un bloc force une hauteur.
        chevauche:
          document.documentElement.scrollHeight > window.innerHeight + 1
            ? `oui, ${document.documentElement.scrollHeight - window.innerHeight} px de trop`
            : 'non',
        // « La barre n'est pas tout en bas » a deux causes possibles, et elles
        // n'appellent pas du tout la même correction :
        //   - la barre s'arrête avant le bas de la **fenêtre** : c'est notre
        //     mise en page, donc corrigeable ;
        //   - elle touche le bas de la fenêtre, mais la fenêtre s'arrête avant
        //     le bord de l'**écran** : hors de portée du CSS, seule la teinte
        //     de la bande peut alors être ajustée.
        barre: (() => {
          // `.safe-bottom` ne porte que sur la barre d'onglets du téléphone.
          // Viser `nav` tout court attrape la barre latérale du bureau, cachée
          // ici et donc haute de zéro : la mesure serait fausse sans rien
          // signaler.
          const nav = document.querySelector('nav.safe-bottom')
          if (!nav) return 'sans objet (affichage bureau)'
          const ecart = Math.round(window.innerHeight - nav.getBoundingClientRect().bottom)
          const horsFenetre = Math.round(window.screen.height - window.innerHeight)
          return `${ecart} px sous la barre · ${horsFenetre} px hors fenêtre`
        })(),
      })
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])

  if (!info) return null

  const lines = [
    `Build : ${info.build}`,
    `Version installée : ${formatVersion(update.installed)}`,
    `Version disponible : ${
      update.ready
        ? update.available
          ? formatVersion(update.available)
          : 'téléchargée · numéro indisponible'
        : 'aucune en attente'
    }`,
    `Mise à jour : ${formatUpdateStatus(update)}`,
    `Affichage : ${info.affichage}`,
    `Écran : ${info.ecran}`,
    `Fenêtre : ${info.fenetre}`,
    `Marges : ${info.marges}`,
    `Hauteur : ${info.hauteur}`,
    `Débordement : ${info.chevauche}`,
    `Barre : ${info.barre}`,
  ]

  return (
    <section className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Diagnostic d'affichage
      </h3>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        À transmettre en cas de problème de mise en page ou de mise à jour. Une nouvelle
        version reste en attente jusqu'à ta confirmation et ne s'installe jamais pendant
        une vacation.
      </p>

      <dl className="tabular flex flex-col gap-1 text-sm">
        {lines.map((line) => {
          const [key, value] = line.split(' : ')
          return (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-slate-500">{key}</dt>
              <dd className="text-right font-semibold">{value}</dd>
            </div>
          )
        })}
      </dl>

      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(lines.join('\n'))
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          } catch {
            setCopied(false)
          }
        }}
        className="pressable mt-3 w-full rounded-xl bg-ink-700 py-2.5 text-sm font-semibold text-slate-300"
      >
        {copied ? 'Copié' : 'Copier ces informations'}
      </button>

      <button
        type="button"
        onClick={() => {
          document.documentElement.classList.toggle('debug-layout')
          setDebug(document.documentElement.classList.contains('debug-layout'))
        }}
        className="pressable mt-2 w-full rounded-xl bg-ink-700 py-2.5 text-sm font-semibold text-slate-300"
      >
        {debug ? 'Masquer les repères' : 'Afficher les repères de mise en page'}
      </button>

      {debug && (
        <p className="mt-2 text-xs text-slate-500">
          Cadre vert : l'application. Cadre orange : la barre du bas. Pointillés bleus : la
          zone de contenu. Le rouge visible hors du cadre vert est extérieur à
          l'application. Une capture d'écran suffit alors à situer le problème.
        </p>
      )}
    </section>
  )
}

function formatVersion(value: AppVersionInfo): string {
  const date = new Date(value.buildTime)
  const build = Number.isNaN(date.getTime()) ? value.buildTime : date.toLocaleString('fr-FR')
  return `v${value.version} · ${build}`
}

function formatUpdateStatus(update: AppUpdateControl): string {
  if (update.installing) return 'installation confirmée'
  if (update.ready) return 'en attente de confirmation'
  if (update.lastError) return 'vérification impossible · version actuelle utilisable'
  if (update.registered) {
    return update.online ? 'à jour' : 'hors ligne · version actuelle utilisable'
  }
  return 'service worker indisponible · application utilisable'
}
