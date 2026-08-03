<p align="center">
  <img src="public/icon-192.png" width="96" height="96" alt="Icône PrepaTrack">
</p>

<h1 align="center">PrepaTrack</h1>

<p align="center">
  Suivi de préparation de commandes, local-first, hors ligne et auto-hébergeable.
</p>

<p align="center">
  <a href="https://github.com/N0thyTVOff/PrepaTrack/actions/workflows/ci.yml"><img src="https://github.com/N0thyTVOff/PrepaTrack/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/N0thyTVOff/PrepaTrack/releases/latest"><img src="https://img.shields.io/github/v/release/N0thyTVOff/PrepaTrack" alt="Dernière version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-AGPL--3.0-blue" alt="Licence AGPL-3.0"></a>
  <a href="https://github.com/N0thyTVOff/PrepaTrack/issues"><img src="https://img.shields.io/github/issues/N0thyTVOff/PrepaTrack" alt="Issues ouvertes"></a>
</p>

PrepaTrack est une PWA pensée pour être utilisée d'une main sur iPhone pendant une
vacation, puis consultée sur PC. La journée reste entièrement fonctionnelle sans
réseau : les données sont enregistrées dans IndexedDB et la synchronisation Supabase
reprend automatiquement lorsque la connexion revient.

## Fonctionnalités

- suivi linéaire de la journée, des commandes, pauses, trajets et aléas ;
- chronos fiables après veille, verrouillage ou fermeture de l'application ;
- comptage des colis, supports et lignes de commande ;
- correction a posteriori sans créer de trou ni de chevauchement dans la timeline ;
- statistiques de cadence, temps perdu et recommandations déterministes ;
- détection locale et optionnelle des déplacements du chariot ;
- sauvegarde et restauration complètes ;
- synchronisation facultative iPhone ↔ PC et vue d'équipe pour les gestionnaires ;
- installation PWA et utilisation hors ligne sans serveur applicatif dédié.

## Démarrage rapide

Prérequis : [Node.js 22](https://nodejs.org/) et Git.

```bash
git clone https://github.com/N0thyTVOff/PrepaTrack.git
cd PrepaTrack
npm ci
npm run dev
```

Ouvre ensuite <http://localhost:5173>. Aucune base distante n'est nécessaire pour
tester le suivi local.

Pour une installation complète avec HTTPS, PWA et synchronisation multi-appareils,
consulte le [guide d'installation](INSTALLATION.md).

## Architecture en bref

```text
Interface React
      │
      ▼
Machine d'état + calculs purs
      │
      ▼
IndexedDB / Dexie ──── synchronisation différée ──── Supabase + RLS
```

La timeline est une suite de segments strictement linéaires. Un seul segment est
ouvert à la fois et toutes les durées sont recalculées depuis des horodatages absolus.
Cette règle évite les doubles comptages et garantit des chiffres exacts après une
longue mise en veille.

Les détails du modèle, des invariants et de la synchronisation sont documentés dans
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Deux métriques distinctes

- **Colis manquants estimés** : estimation du nombre de colis qui auraient pu être
  préparés pendant le temps perdu, calculée avec la cadence cible. Ce chiffre ne
  représente pas des colis physiques en rupture de stock.
- **Colis manquants pour rupture** : quantité réellement indisponible signalée pendant
  une commande.

Ces valeurs répondent à deux questions différentes et ne sont jamais additionnées.

## Qualité et sécurité

```bash
npm run lint       # règles TypeScript et React
npm run typecheck  # vérification TypeScript
npm test           # suite de tests déterministes
npm run build      # build de production
npm run db:check   # contrôle hors ligne du schéma et des règles RLS
npm audit          # audit des dépendances
```

La CI exécute ces contrôles sur chaque pull request. `main` est protégée, les Actions
externes nécessitent l'approbation du mainteneur, et GitHub analyse les secrets avant
chaque push.

Les données métier ne transitent jamais par ce dépôt. La clé Supabase `anon` est
publique par conception ; l'accès aux données repose sur l'authentification et les
règles Row Level Security fournies dans `supabase/`.

Pour signaler une vulnérabilité, utilise le rapport privé décrit dans
[SECURITY.md](SECURITY.md), jamais une issue publique.

## Organisation du dépôt

| Chemin | Responsabilité |
|---|---|
| `src/core/` | modèle, machine d'état, métriques et analyses pures |
| `src/db/` | stockage IndexedDB et unique couche d'écriture métier |
| `src/sync/` | authentification, mapping et synchronisation Supabase |
| `src/hooks/` | orchestration React des données et capacités du navigateur |
| `src/screens/` | écrans et feuilles d'édition |
| `src/components/` | composants visuels réutilisables |
| `supabase/` | schéma SQL, rôles, déclencheurs et politiques RLS |
| `.github/` | CI, releases, sécurité et formulaires d'issues |

## Contributions et releases

Les bugs et propositions passent par les [formulaires d'issues](https://github.com/N0thyTVOff/PrepaTrack/issues/new/choose).
Le mainteneur réalise ensuite les changements sur une branche du dépôt. Les règles de
contribution et le processus de release sont détaillés dans
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

Fusionner une PR applicative met à jour une Release PR sans déployer. La production
n'est publiée qu'après fusion manuelle de cette Release PR :

```text
branche → PR → CI → main → Release PR → validation manuelle → tag → production
```

## Licence et attribution

PrepaTrack est distribué sous licence [GNU AGPL-3.0](LICENSE). Tu peux l'utiliser,
le modifier et le republier, y compris commercialement, à condition de respecter la
licence, de rendre disponible le code source correspondant et de conserver
l'attribution vers le [dépôt officiel](https://github.com/N0thyTVOff/PrepaTrack)
définie dans [NOTICE](NOTICE).
