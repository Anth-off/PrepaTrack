# Architecture de PrepaTrack

Ce document décrit les décisions qui doivent rester vraies lorsqu'une fonctionnalité
est ajoutée. Il complète les commentaires placés au plus près des algorithmes.

## Principes

### Local-first

IndexedDB est la source de vérité pendant la vacation. Aucune transition métier ne
dépend du réseau. Supabase est un miroir de synchronisation et de consultation
multi-appareils, pas le moteur de l'application.

### Timeline linéaire

Une journée est une suite de segments non chevauchants. Un seul segment peut être
ouvert. Démarrer une interruption ferme le segment actif et mémorise ce qu'elle devra
reprendre dans `Segment.stack`.

Ces invariants impliquent :

- aucune durée accumulée dans un compteur en mémoire ;
- des calculs fondés uniquement sur `startedAt` et `endedAt` ;
- une reprise exacte après veille, crash ou batterie vide ;
- une somme des segments égale au temps de présence.

### Calculs purs

La machine d'état, les métriques, analyses et recommandations vivent dans `src/core/`.
Elles ne connaissent ni React, ni IndexedDB, ni Supabase et sont testées avec des
horodatages déterministes.

## Flux d'une action

```text
geste utilisateur
      │
      ▼
écran / composant React
      │
      ▼
commande de src/db/repo.ts
      │
      ├── valide la transition avec src/core/machine.ts
      ├── écrit atomiquement dans Dexie
      └── marque les lignes « pending »
                                  │
                                  ▼
                         src/sync/sync.ts
                                  │
                                  ▼
                         Supabase protégé par RLS
```

`src/db/repo.ts` est le seul point d'écriture métier. Écrire directement dans une
table Dexie depuis un écran contournerait les invariants et la synchronisation.

## Modèle de données

| Entité | Rôle |
|---|---|
| `Workday` | bornes et état d'une vacation |
| `Order` | commande, type, colis, lignes et supports |
| `Segment` | intervalle de temps typé, éventuellement rattaché à une commande |
| `ColisEvent` | incrément horodaté du compteur de colis |
| `Settings` | préférences locales et calibration du chariot |

Les lignes synchronisées portent `updatedAt`, `syncState`, `ownerId` et éventuellement
`deletedAt`. Les suppressions sont logiques : retirer physiquement une ligne en local
la ferait réapparaître au prochain téléchargement.

## Synchronisation

Une synchronisation suit toujours cet ordre :

1. télécharger les changements distants depuis le dernier curseur ;
2. résoudre chaque conflit par `updatedAt` ;
3. envoyer les lignes locales `pending` ;
4. avancer le curseur seulement après succès du lot.

À horodatage égal, aucune écriture n'est effectuée : il s'agit généralement de la ligne
qui vient d'être envoyée. Les `null` PostgreSQL sont normalisés en `undefined` avant de
revenir dans le modèle TypeScript.

## Sécurité

La frontière de sécurité se trouve dans Supabase :

- l'utilisateur est authentifié avant toute synchronisation ;
- chaque ligne métier porte son propriétaire ;
- les politiques RLS filtrent lecture et écriture ;
- les fonctions privilégiées contrôlent le rôle `manager` ;
- la clé `anon` peut être publique, contrairement à `service_role` et à l'URI PostgreSQL.

Le schéma est rejouable et `npm run db:check` vérifie hors ligne la présence des tables,
politiques, rôles et déclencheurs attendus.

## Ajouter une fonctionnalité

1. Étendre le modèle dans `src/core/types.ts` si nécessaire.
2. Définir la transition ou le calcul sous forme pure dans `src/core/`.
3. Ajouter les tests avant de brancher l'interface.
4. Exposer l'écriture uniquement via `src/db/repo.ts`.
5. Mettre à jour les mappings de `src/sync/` et le SQL si la donnée doit être partagée.
6. Vérifier le mode avion et la reprise après fermeture sur téléphone.

Une modification de schéma doit rester compatible avec les anciennes versions déjà
installées : une PWA peut continuer à fonctionner hors ligne plusieurs jours avant de
récupérer la release suivante.
