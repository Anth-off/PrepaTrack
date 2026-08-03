# Contribuer à PrepaTrack

## Contributions publiques

Les retours et signalements sont bienvenus dans les issues GitHub. Pour préserver le
contrôle de la production et des données métier, seuls les mainteneurs du dépôt créent
et fusionnent les pull requests. Une proposition externe peut être décrite dans une
issue ; le mainteneur réalisera ensuite le changement sur une branche du dépôt.

Ne publie jamais dans une issue, une capture ou un commentaire : code personnel,
numéro de badge réel, mot de passe, jeton, clé d'API ou donnée nominative d'un membre
de l'équipe. Une vulnérabilité doit être signalée selon la procédure de `SECURITY.md`.

Le principe : **rien ne part en production sans une décision explicite**. Fusionner
dans `main` n'expédie rien chez les préparateurs ; seule la fusion de la Release PR
le fait.

C'est volontaire. L'application est utilisée pendant les vacations, sans réseau : une
version cassée n'est pas rattrapable dans la journée.

---

## Le flux, de bout en bout

```
branche de travail
      │
      ▼
  pull request ──────► CI (types · tests · build · schéma)
      │                     tout doit passer
      ▼
  fusion dans main
      │
      ▼
  Release Please met à jour la Release PR
  (version calculée, changelog rédigé — rien n'est déployé)
      │
      ▼
  TU fusionnes la Release PR  ◄── la seule décision manuelle
      │
      ▼
  tag + GitHub Release
      │
      ▼
  vérifications rejouées sur le tag
      │
      ▼
  déploiement en production
```

Autrement dit : `main` est toujours prêt à sortir, mais ne sort que quand tu le décides.

---

## Nommer une branche

```
feat/vue-equipe-hebdomadaire
fix/chrono-reprise-apres-trajet
docs/guide-preparateurs
refactor/decoupage-ecran-equipe
```

Préfixe = type du changement, puis une description courte en tirets. Pas d'espaces,
pas d'accents.

---

## Écrire un commit

Le format vient des [Conventional Commits](https://www.conventionalcommits.org/fr/).
Il n'est pas décoratif : **c'est lui qui calcule le numéro de version et rédige le
changelog**.

| Préfixe | Quand | Effet sur la version |
|---|---|---|
| `feat:` | nouvelle fonctionnalité | 0.**1**.0 → 0.**2**.0 |
| `fix:` | correction d'un défaut | 0.1.**0** → 0.1.**1** |
| `perf:` | amélioration de performance | correctif |
| `refactor:` | restructuration sans changement visible | aucun |
| `docs:` | documentation | aucun |
| `test:` | tests | aucun |
| `build:` | outillage de build, dépendances | aucun |
| `ci:` | intégration continue | aucun |
| `chore:` | maintenance diverse | aucun |
| `feat!:` ou `BREAKING CHANGE:` | rupture de compatibilité | version majeure |

Un scope quand c'est utile : `fix(prepa): ...`, `feat(equipe): ...`.

### Exemples tirés de ce projet

```
feat(equipe): ajouter le classement à densité égale
fix(prepa): cumuler le chrono au lieu de repartir à zéro après un trajet
fix(cadence): exclure les aléas et changements de palette du dénominateur
docs: expliquer le flux de contribution
ci: paralléliser les vérifications
```

Rupture de compatibilité — à utiliser avec précaution, ces changements touchent des
données déjà enregistrées :

```
feat(donnees)!: renommer le champ des supports

BREAKING CHANGE: les sauvegardes antérieures doivent être réimportées.
```

### Le titre de la pull request compte plus que les commits

Les PR sont fusionnées en **squash** : le titre de la PR devient le message de commit
dans `main`. C'est donc **lui** que Release Please lit.

Un workflow refuse la PR si son titre ne suit pas la convention. Les commits à
l'intérieur de la branche sont libres.

---

## Ouvrir une pull request

1. Pousser la branche, ouvrir la PR vers `main`.
2. Donner un titre au format Conventional Commits.
3. Remplir le gabarit — en particulier **Points d'attention** si le changement touche
   un calcul de temps, le schéma de base ou le format des données stockées.
4. Attendre la CI.

---

## Ce que fait la CI

Sur chaque pull request et chaque push dans `main`, quatre vérifications tournent **en
parallèle** :

| Vérification | Commande | Ce qu'elle attrape |
|---|---|---|
| Types | `npm run typecheck` | erreurs de typage |
| Tests | `npm test` | régressions sur les calculs de cadence et la machine à états |
| Build | `npm run build:vite` | échec de compilation, artefact conservé 7 jours |
| Schéma | `npm run db:check` | perte des règles de sécurité, protection en cascade retirée |

Un cinquième job, `CI`, agrège les résultats : c'est celui à exiger dans la protection
de branche, plutôt que d'y lister les quatre.

Le contrôle du schéma **ne se connecte à aucune base** et ne détient aucun identifiant.
Il lit les fichiers de `supabase/` et vérifie qu'ils n'ont pas perdu leurs garde-fous.

La vérification des types tourne dans son propre job ; le job de build lance donc
`build:vite` seul, pour ne pas compiler deux fois.

---

## La Release PR

Après chaque fusion dans `main`, Release Please ouvre — ou met à jour — une pull
request intitulée `chore(main): release X.Y.Z`.

Elle contient :

- la nouvelle version dans `package.json` et `.release-please-manifest.json` ;
- le `CHANGELOG.md` rédigé à partir des commits.

**Tant qu'elle n'est pas fusionnée, rien n'est déployé.** Elle s'enrichit à chaque
changement fusionné dans `main`.

### Déclencher une mise en production

Fusionner la Release PR. C'est tout, et c'est le seul moyen.

Il s'ensuit automatiquement : le tag, la GitHub Release, les vérifications rejouées
sur le tag, puis le déploiement.

Les vérifications sont **rejouées** parce que le commit de release n'est pas celui qui
a été testé en PR : le squash produit un arbre différent, et Release Please y ajoute
encore la version et le changelog.

---

## Relancer un job en échec

**Actions** → l'exécution concernée → **Re-run failed jobs**.

Le déploiement est un job distinct : s'il échoue seul, on peut le relancer sans
refaire de release ni retoucher le tag.

Si l'échec vient du code et non d'un aléa d'infrastructure, il faut corriger par une
nouvelle PR : le tag existant reste tel quel, et la correction produira une version
suivante.

---

## Revenir en arrière

### Le plus rapide — depuis Vercel

Tableau de bord Vercel → **Deployments** → le déploiement précédent → **Promote to
Production**. Effet immédiat, aucun passage par le dépôt.

C'est la marche à suivre quand des préparateurs sont en poste : on rétablit d'abord,
on corrige ensuite.

### Proprement — par le dépôt

1. `git revert` du commit fautif, dans une PR au format `fix: ...`.
2. Fusionner la PR, puis la Release PR qui suit.
3. Une nouvelle version part en production.

### Ce que le rollback ne défait pas

**Les changements de base de données.** Le schéma est appliqué à part, par
`npm run db:setup`. Revenir à une version antérieure de l'application ne retire ni une
table ni une colonne ajoutée.

Avant toute modification de `supabase/`, se demander si l'application précédente
fonctionnerait encore avec le nouveau schéma. Si la réponse est non, le changement doit
être découpé en deux versions.

---

## Base de données

Les migrations **ne sont pas automatisées**, délibérément :

- `npm run db:check` — contrôle hors ligne, tourne en CI ;
- `npm run db:setup` — applique le schéma, **manuellement**, depuis un poste
  disposant des identifiants.

Le fichier `supabase/schema.sql` est écrit pour être rejoué sans risque : il ne crée
que ce qui manque et ne touche jamais aux données existantes. Aucune opération
destructive n'est automatisée, et aucun identifiant de base n'est confié à la CI.

**Avant une modification de schéma en production** : exporter une sauvegarde depuis
l'application (Réglages → Sauvegarde) et vérifier la rétention des sauvegardes
Supabase.

---

## Les pull requests de Dependabot

Dependabot ouvre chaque mois des PR de mise à jour. Elles suivent le flux normal :
la CI tourne, et le contenu ne part en production qu'après une Release PR.

**Le contrôle de titre ne s'y applique pas.** Le bot écrit « ci: Bump actions/checkout
from 5 to 7 », avec une majuscule qu'on ne peut pas lui faire retirer. Exiger la
convention d'un auteur qui ne peut pas s'y plier n'aurait fait que peindre en rouge des
PR parfaitement valides. Le préfixe `ci:` / `build:`, lui, vient de
`.github/dependabot.yml` : Release Please lit bien un message conventionnel.

**Les montées majeures arrivent isolées, les mineures groupées.** Une majeure noyée dans
un lot fait échouer la CI sans qu'on sache laquelle est en cause.

### Que faire d'une PR Dependabot dont la CI échoue

Ne pas la fusionner, et ne pas la corriger dans sa branche — Dependabot la réécrit à
chaque passage. Deux issues :

- la montée vaut le coup → faire la migration dans **une PR à soi**, puis fermer celle du
  bot ;
- elle ne vaut pas le coup maintenant → ajouter la dépendance à `ignore` dans
  `.github/dependabot.yml`, avec le motif en commentaire.

C'est ce qui a été fait pour **Tailwind 4** : ce n'est pas une montée de version mais une
migration (le plugin PostCSS déménage dans `@tailwindcss/postcss`, la configuration change
de forme). Les 3.x continuent d'arriver ; la 4 attendra une PR dédiée.

---

## Secrets à créer

Dans **Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Où le trouver | Utilisé par |
|---|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens | déploiement |
| `VERCEL_ORG_ID` | `.vercel/project.json`, champ `orgId` | déploiement |
| `VERCEL_PROJECT_ID` | `.vercel/project.json`, champ `projectId` | déploiement |

`GITHUB_TOKEN` est fourni par GitHub, il n'y a rien à créer.

Aucun identifiant de base de données n'est nécessaire : la CI ne se connecte jamais à
Supabase.

Le fichier `.vercel/` est ignoré par git — d'où la reprise de ces deux identifiants en
secrets.

---

## Réglages GitHub du dépôt officiel

Le dépôt officiel applique les protections suivantes :

1. **Environnement de production** — Settings → Environments → **New environment**,
   nommé `production`.
   Y ajouter éventuellement des *required reviewers* : le déploiement attendra alors
   une approbation, en plus de la fusion de la Release PR.

2. **Protection de la branche `main`** :
   - exiger une pull request avant fusion ;
   - exiger le check **`CI`** ;
   - exiger une branche à jour et la résolution des conversations ;
   - interdire force-push et suppression, y compris au mainteneur ;
   - autoriser **uniquement la fusion en squash** et conserver un historique linéaire.

3. **Permissions des workflows** — Settings → Actions → General :
   - *Workflow permissions* : **Read repository contents and packages permissions** ;
     les workflows demandent explicitement ce dont ils ont besoin ;
   - les workflows ne peuvent pas approuver une pull request ;
   - tout workflow proposé depuis un fork attend l'approbation du mainteneur.

4. **Sécurité** : secret scanning, push protection, Dependabot, rapports privés de
   vulnérabilité et analyse CodeQL JavaScript/TypeScript sont activés.

### Une limite connue

La CI **ne se déclenchera pas automatiquement sur la Release PR**. GitHub n'enchaîne
pas les workflows sur un événement créé avec `GITHUB_TOKEN` — c'est une protection
contre les boucles infinies.

Trois options :

- **ne rien faire** (retenu ici) : les vérifications sont rejouées sur le tag, juste
  avant le déploiement. Le contenu est de toute façon déjà passé en CI lors de sa PR
  d'origine ;
- lancer la CI à la main sur la Release PR (`workflow_dispatch`) ;
- créer une GitHub App et utiliser son token à la place de `GITHUB_TOKEN`. Plus lourd,
  et sans réel gain ici.

---

## Réglages côté Vercel

Le fichier `vercel.json` désactive le déploiement automatique de `main` :

```json
{ "git": { "deploymentEnabled": { "main": false } } }
```

**Sans lui, il y aurait deux productions concurrentes** : celle de Vercel à chaque
fusion dans `main`, et celle de la CI à chaque release. La première rendrait la seconde
inutile, et la Release PR ne contrôlerait plus rien.

Ce réglage laisse intactes :

- les **previews sur les autres branches**, utiles pour relire une PR ;
- les **déploiements par la CLI**, c'est-à-dire ceux de notre workflow.

> Ce fichier n'a d'effet **que si le dépôt GitHub est connecté au projet Vercel**. S'il
> ne l'est pas, le déploiement passe uniquement par la CI et il n'y a aucun conflit —
> le fichier reste alors sans effet, mais protège d'une connexion faite plus tard.

---

## Vérifier avant de pousser

```bash
npm run typecheck
npm test
npm run build
npm run db:check
```
