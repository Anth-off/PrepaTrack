import { useState } from 'react'
import {
  ESTIMATED_MISSING_HELP,
  ESTIMATED_MISSING_LABEL,
  STOCK_SHORTAGE_LABEL,
} from '../core/metricLabels'
import type { Role } from '../sync/profile'

interface Props {
  role?: Role
}

/**
 * Mode d'emploi intégré. Les préparateurs n'auront ni le dépôt, ni le fichier
 * d'installation : ce qu'ils doivent savoir doit tenir dans l'application.
 */
export function HelpSection({ role }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <section className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Comment ça marche
        </h3>
        <span className="text-slate-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-4 text-sm text-slate-300">
          <Block title="Une journée">
            <p>
              <b>Commencer la journée</b> lance le briefing. <b>Fin du briefing</b> enchaîne
              tout seul sur la prépa du poste. Ensuite <b>Nouvelle commande</b> : nombre de
              colis, nombre de lignes, type.
            </p>
            <p className="mt-1">
              Puis le gros bouton suit la commande : recherche palette → prépa → filmage →
              mise à quai. À la fin, l'app demande les supports utilisés.
            </p>
          </Block>

          <Block title="Les six boutons du bas">
            <p>
              <b>Trajet</b>, <b>WC</b>, <b>Filmage</b>, <b>Palette</b>, <b>Aléa</b>,{' '}
              <b>Pause</b>. Un appui
              démarre, un second arrête — c'est le même bouton. Ce qui tournait avant
              reprend tout seul à la fermeture.
            </p>
            <p>
              <b>Filmage</b> est disponible pendant la prépa pour sécuriser une palette
              sans terminer la commande. Ce temps s'ajoute au filmage final dans les
              statistiques.
            </p>
            <p className="mt-1 text-slate-400">
              Tu peux les utiliser à tout moment, même en pleine commande. Le temps est
              décompté séparément, il ne pénalise pas ta cadence de prélèvement.
            </p>
          </Block>

          <Block title="Le compteur pendant la prépa">
            <p>
              Les boutons <b>+1</b> et <b>+10</b> servent à dire où tu en es. C'est ce qui
              permet d'afficher ton avance ou ton retard en direct. Si tu n'y penses pas,
              rien n'est perdu : le total est demandé en fin de commande.
            </p>
          </Block>

          <Block title="Corriger le dernier appui">
            <p>
              Après une action réversible, le bouton <b>Annuler</b> reste disponible pendant
              10 secondes. Il remet exactement le compteur, la commande ou le chrono dans
              son état précédent, même sans réseau.
            </p>
            <p className="mt-1 text-slate-400">
              Passé ce délai, la correction reste possible depuis le bilan de la journée.
            </p>
          </Block>

          <Block title="Un colis est en rupture">
            <p>
              Pendant la prépa, appuie sur <b>📦 +1 hors stock</b> à la place du bouton
              <b> +1</b>. Le colis n'entre pas dans le total préparé et le total hors stock
              augmente immédiatement, sans formulaire.
            </p>
            <p className="mt-1 text-slate-400">
              Un mauvais appui peut être annulé pendant 10 secondes. Le total reste
              modifiable dans le bilan et sera transmis au gestionnaire au retour du réseau.
            </p>
          </Block>

          <Block title="Comprendre les colis manquants">
            <p>
              <b>{ESTIMATED_MISSING_LABEL}</b> : {ESTIMATED_MISSING_HELP}
            </p>
            <p className="mt-1 text-slate-400">
              <b>{STOCK_SHORTAGE_LABEL}</b> désigne au contraire une quantité réellement
              indisponible. Ces deux chiffres restent toujours séparés.
            </p>
          </Block>

          <Block title="Si tu oublies d'appuyer">
            <p>
              Ça arrive et ça se répare. Ouvre le bilan de la journée, puis le{' '}
              <b>tracé</b> en bas : chaque ligne est modifiable — heure de début, de fin,
              type de chrono. Les lignes voisines se recalent toutes seules.
            </p>
          </Block>

          <Block title="Sans réseau">
            <p>
              Tout fonctionne en mode avion. Les données partent toutes seules dès que le
              téléphone retrouve du réseau, en sortant du bâtiment ou à la maison.
              L'indicateur « en attente » dans les réglages te dit ce qu'il reste à envoyer.
            </p>
          </Block>

          <Block title="Qui voit tes chiffres">
            <p>
              Ta production n'est visible que par toi et par les gestionnaires. Tu ne vois
              pas celle des autres, et les autres ne voient pas la tienne.
            </p>
            {role === 'manager' && (
              <p className="mt-1 text-info">
                Ton compte est gestionnaire : tu vois la production de toute l'équipe et tu
                peux gérer les comptes depuis l'onglet Équipe.
              </p>
            )}
          </Block>

          <Block title="Ton code personnel">
            <p>
              Il protège tes chiffres : ne le communique à personne. En cas d'oubli, un
              gestionnaire peut t'en redéfinir un — il ne peut pas lire l'ancien.
            </p>
          </Block>
        </div>
      )}
    </section>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 font-bold text-slate-100">{title}</h4>
      {children}
    </div>
  )
}
