# PrepaTrack

Suivi de production pour préparateur de commandes en entrepôt.
Application web hors ligne, utilisée à une main sur iPhone pendant la vacation et
consultée sur PC le soir.

Distribué sous licence [GNU AGPL v3](LICENSE). Toute redistribution doit conserver
l'attribution indiquée dans [NOTICE](NOTICE).

**Installation : voir [INSTALLATION.md](INSTALLATION.md).**

## Commandes

```bash
npm run dev        # serveur de développement
npm test           # suite de tests
npm run typecheck  # vérification des types seule
npm run build      # build de production (types + bundle)
npm run db:check   # valide les fichiers de schéma, hors ligne
npm run db:setup   # applique supabase/schema.sql sur la base distante (rejouable)
```

## Contribuer et mettre en production

**Rien ne part en production sans une décision explicite.** Fusionner dans `main`
n'expédie rien : cela met seulement à jour une *Release PR*. C'est la fusion de cette
Release PR qui crée la version, le tag et déclenche le déploiement.

```
branche → pull request → CI → main → Release PR → (fusion manuelle) → tag → production
```

Les messages de commit suivent les [Conventional Commits](https://www.conventionalcommits.org/fr/)
(`feat:`, `fix:`, `docs:`…) : ce sont eux qui calculent le numéro de version et rédigent
le changelog. Comme les PR sont fusionnées en squash, **c'est le titre de la pull
request** qui compte.

**Le détail complet — nommage des branches, CI, rollback, secrets à créer et réglages
GitHub restant à faire : [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).**

## Principe de fonctionnement

La journée est enregistrée comme une **suite de segments strictement linéaires et non
chevauchants**. Un seul segment est ouvert à la fois : lancer un trajet pendant une prépa
ferme le segment `picking` et en ouvre un `travel` ; à la fermeture du trajet, un nouveau
segment `picking` reprend automatiquement.

Deux conséquences directes :

- la somme des durées est **toujours exactement** égale au temps de présence, sans trou ni
  double comptage ;
- les trois cadences se calculent en choisissant simplement quels segments entrent au
  dénominateur, sans aucune soustraction.

Une interruption porte la **pile** de ce qu'elle suspend (`Segment.stack`). Une pause prise
pendant un trajet lui-même pris pendant une prépa porte `[picking, travel]` : fermer la
pause rouvre le trajet, fermer le trajet rouvre la prépa. Comme la pile est stockée sur le
segment lui-même, la reprise survit à un crash ou à une fermeture de l'app par iOS.

**Aucune durée n'est jamais accumulée en mémoire.** Tout est recalculé depuis des
horodatages absolus, ce qui rend les chiffres exacts après une mise en veille.

## Les trois cadences

| Cadence | Dénominateur |
|---|---|
| Prépa pure | segments `picking` uniquement |
| Commande | segments rattachés à une commande, **pauses réglementaires exclues** |
| Journée | présence totale moins les pauses réglementaires |

## Organisation du code

| Chemin | Rôle |
|---|---|
| `src/core/types.ts` | modèle de données et invariants |
| `src/core/machine.ts` | machine à états (logique pure, testée isolément) |
| `src/core/metrics.ts` | cadences, répartition du temps, suivi en direct |
| `src/core/segments.ts` | registre des types de segments et leurs catégories |
| `src/core/alerts.ts` | alertes fin de pause et chrono oublié |
| `src/core/analysis.ts` | analyses croisées (type, densité, heure, jour, pertes) |
| `src/core/recommendations.ts` | règles déterministes produisant les constats chiffrés |
| `src/core/fixtures.ts` | fabrique de vacations pour les tests, jamais importée par l'app |
| `src/db/repo.ts` | **seul point d'écriture** : toutes les transitions passent par là |
| `src/screens/` | écrans |
| `src/components/` | composants tactiles |

## Tests

`src/db/repo.test.ts` rejoue une vacation complète (briefing, deux commandes, trois pauses,
trajets, panne d'engin, heures supplémentaires, rangement) et vérifie que la timeline reste
continue et que les cadences tombent juste. C'est le garde-fou principal : une erreur de
comptage du temps est invisible à l'œil nu dans l'interface.

## État d'avancement

- [x] **Lot 1 — Le tracker** : machine à états, chronos, stockage local, PWA, bilan de
      journée, correction a posteriori
- [x] **Lot 2 — La synchro** : Supabase, connexion par mot de passe, rejeu automatique,
      tableau de bord PC
- [x] **Lot 3 — Les stats** : analyses croisées, graphiques, moteur de recommandations
- [x] **Lot 4 — Multi-utilisateurs** : connexion par badge et code personnel, rôles
      préparateur / gestionnaire, vue d'équipe
- [x] **Lot 5 — Ouverture à l'équipe** : comparaison à densité égale, aléas
      personnalisables, clôture d'une vacation oubliée, aide intégrée
- [ ] **Lot 6 — Exports** : CSV et récap imprimable
      (la sauvegarde/restauration complète est déjà livrée, `src/db/backup.ts`)

## Comparer des préparateurs sans les trahir

Comparer des cadences brutes est **faux** : celui qui reçoit les commandes les plus
éclatées sort mécaniquement plus bas, sans que son rythme soit en cause. Sur les données
réelles du 30 juillet, l'écart entre commandes groupées et éclatées atteint 41 colis/h.

`performanceByOwner()` dans [analysis.ts](src/core/analysis.ts) applique une
**standardisation directe** : on calcule la cadence de référence de l'équipe par tranche
de densité, puis le temps qu'il aurait fallu à chacun *sur ses propres commandes*. L'écart
entre le réalisé et l'attendu est le seul chiffre comparable d'une personne à l'autre.

Deux garde-fous, parce que ce chiffre peut être opposé à quelqu'un :

- **L'agrégation se fait par le temps, jamais par la moyenne des cadences.** Moyenner deux
  cadences donne un résultat faux dès que les commandes n'ont pas la même taille.
- **Un préparateur seul sur son type de commande est écarté du classement** (`comparableShare`).
  Il serait sa propre référence, son écart vaudrait zéro par construction, et l'écran
  afficherait « pile dans la norme » sans qu'aucune comparaison n'ait eu lieu.

## Rôles et cloisonnement

Deux rôles : `preparer` et `manager`. Les règles sont appliquées **par la base**
(sécurité au niveau ligne), jamais par l'interface — masquer un bouton n'a jamais
protégé une donnée.

Un préparateur s'identifie par son numéro de badge. Supabase authentifiant par
e-mail, une adresse technique est fabriquée à partir du badge
(`1234567@prepatrack.local`) ; ce domaine n'existe pas et ne reçoit jamais rien, le
code personnel à 6 chiffres tient lieu de mot de passe.

Un compte ne peut pas être créé librement : un déclencheur exige que le badge ait été
déclaré au préalable par un gestionnaire, et refuse un badge déjà rattaché.

Côté client, chaque ligne porte un `ownerId`. Un gestionnaire reçoit les vacations de
toute l'équipe dans sa base locale : sans ce champ, il « reprendrait » la journée en
cours d'un préparateur en ouvrant l'application. Les lignes sans propriétaire — créées
avant toute connexion — restent rattachées au compte courant.

## Synchronisation

`src/sync/` recopie les tables locales dans Supabase. Trois règles en portent la fiabilité :

1. **On descend avant de remonter.** Sinon une correction faite le soir sur le PC serait
   écrasée par la version d'origine restée en attente sur le téléphone, dont l'horodatage
   plus ancien ne serait jamais examiné.
2. **Dernier écrit gagnant**, ligne par ligne, sur `updatedAt`. À égalité on ne touche à
   rien : c'est la ligne qu'on vient d'envoyer et qui nous revient.
3. **`null` redevient `undefined`** à la descente. Postgres renvoie `null` là où le code
   teste `endedAt === undefined` pour reconnaître un segment en cours ; sans cette
   conversion, une journée redescendue n'aurait plus aucun chrono en marche.

Aucune clé étrangère entre les tables métier : le client est la source de vérité, le
serveur un miroir de transport. Un envoi interrompu ne peut donc jamais échouer en boucle
sur un ordre d'insertion.

La bibliothèque Supabase est chargée en import dynamique — elle pèse plus que tout le
reste de l'app et ne sert qu'une fois le réseau revenu.
