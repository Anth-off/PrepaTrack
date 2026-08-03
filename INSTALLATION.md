# Installer PrepaTrack

Ce guide couvre trois niveaux indépendants : développement local, hébergement HTTPS,
puis synchronisation Supabase. La synchronisation est facultative ; l'application
locale fonctionne déjà hors ligne.

## Prérequis

- Git ;
- Node.js 22 et npm ;
- un navigateur récent ;
- pour l'iPhone : un hébergement HTTPS ;
- pour la synchronisation : un projet Supabase.

## 1. Lancer l'application localement

```bash
git clone https://github.com/N0thyTVOff/PrepaTrack.git
cd PrepaTrack
npm ci
npm run dev
```

Ouvre <http://localhost:5173>. Pour simuler un téléphone depuis Chrome ou Edge, ouvre
les outils de développement (`F12`) puis active l'affichage mobile.

Contrôle le projet avant toute modification :

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run db:check
```

## 2. Héberger la PWA

PrepaTrack est une application Vite statique. Tout hébergeur HTTPS capable de servir
le dossier `dist/` convient.

### Exemple avec Vercel

```bash
npx vercel login
npx vercel --prod
```

Accepte la création d'un nouveau projet et garde les réglages Vite détectés. L'adresse
HTTPS obtenue permet d'installer la PWA sur l'écran d'accueil.

Le fichier `vercel.json` désactive seulement le déploiement Git automatique de `main`
pour le dépôt officiel, dont les releases sont déployées par GitHub Actions. Un fork
peut supprimer cette section s'il préfère les déploiements automatiques Vercel.

## 3. Créer la base Supabase

Sans Supabase, chaque appareil conserve ses propres données. Avec Supabase, les
changements effectués hors ligne sont rejoués dès le retour du réseau.

### 3.1 Créer le projet

1. Crée un projet depuis <https://supabase.com/dashboard>.
2. Choisis une région proche des utilisateurs et conserve le mot de passe de base.
3. Dans **Authentication → Providers → Email**, désactive la confirmation d'adresse.

PrepaTrack fabrique une adresse technique locale à partir du badge ; aucun courrier
n'est envoyé.

### 3.2 Préparer la configuration d'administration

Copie `.env.example` vers `.env.local` :

```powershell
Copy-Item .env.example .env.local
```

Sur macOS ou Linux :

```bash
cp .env.example .env.local
```

Renseigne ensuite :

```dotenv
SUPABASE_DB_URL=postgresql://postgres.xxxxx:MOT_DE_PASSE@hote:5432/postgres
MANAGER_BADGE=1234567
MANAGER_NAME=Nom du gestionnaire
```

`.env.local` est ignoré par Git. Ne place jamais la chaîne de connexion ou un mot de
passe dans un commit, une issue ou une capture d'écran.

Le certificat Supabase est déjà fourni dans `supabase/prod-ca-2021.crt`. Si Supabase
change son autorité, télécharge le nouveau certificat depuis **Project Settings →
Database → SSL Configuration** et indique son chemin avec `SUPABASE_CA_CERT`.

### 3.3 Appliquer et contrôler le schéma

```bash
npm run db:setup
```

Le script applique dans l'ordre :

1. les tables métier et leurs politiques RLS ;
2. les comptes préparateurs et gestionnaires ;
3. les fonctions et déclencheurs de contrôle d'accès ;
4. le premier gestionnaire déclaré dans `.env.local`.

La commande est rejouable. Pour une installation manuelle, exécute
`supabase/schema.sql` puis `supabase/multi-user.sql` dans le SQL Editor.

## 4. Relier chaque appareil

Dans Supabase, ouvre **Project Settings → API** et récupère :

- la Project URL, de la forme `https://xxxxx.supabase.co` ;
- la clé publique `anon`.

Dans PrepaTrack :

1. ouvre **Réglages → Synchro iPhone ↔ PC** ;
2. colle l'URL et la clé publique ;
3. enregistre ;
4. saisis le badge déclaré et choisis un code personnel à six chiffres ;
5. utilise **Première connexion — définir mon code**.

Répète l'opération sur chaque appareil avec le même compte. Un gestionnaire peut
ensuite ajouter les autres badges depuis l'onglet **Équipe**.

La clé `anon` n'est pas un secret : elle identifie le projet public. Les politiques
RLS limitent chaque requête aux données autorisées pour l'utilisateur connecté. La
clé `service_role`, la chaîne PostgreSQL et les mots de passe ne doivent jamais être
exposés au navigateur.

### Configuration au moment du build

Pour préremplir l'instance sans saisie manuelle, l'hébergeur peut définir :

```dotenv
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=cle_anon_publique
```

Ces deux valeurs seront visibles dans le JavaScript livré, ce qui est normal pour une
clé `anon`. N'utilise jamais une clé de service dans une variable préfixée par `VITE_`.

## 5. Installer sur iPhone

1. Ouvre l'URL HTTPS dans Safari.
2. Appuie sur **Partager**.
3. Choisis **Sur l'écran d'accueil**.
4. Lance désormais PrepaTrack depuis cette icône.

Au premier lancement, interagis une fois avec l'application afin que le navigateur
puisse autoriser les alertes sonores.

## 6. Tester le hors ligne

1. Ouvre l'application installée et crée une journée de test.
2. Active le mode avion.
3. Ferme puis relance l'application.
4. Vérifie qu'une commande et des chronos peuvent toujours être enregistrés.
5. Désactive le mode avion et contrôle dans **Réglages → Synchro** que les éléments en
   attente retombent à zéro.

## Dépannage

### La base refuse la connexion

- vérifie la chaîne `SUPABASE_DB_URL` et son mot de passe ;
- utilise l'URI du pooler si ta connexion ne prend pas en charge IPv6 ;
- renouvelle le certificat Supabase si l'erreur mentionne TLS ou une autorité inconnue.

### La première connexion ne crée pas de session

- vérifie que la confirmation d'adresse est désactivée dans Supabase ;
- vérifie que le badge a été déclaré par un gestionnaire ;
- n'utilise pas un code déjà associé à un autre compte de test.

### La PWA ne se met pas à jour

Ferme complètement l'application installée puis rouvre-la avec une connexion active.
Le service worker récupère la dernière version publiée en arrière-plan.

### La synchronisation ne repart pas

Ouvre **Réglages → Diagnostic d'affichage**, copie les informations des deux appareils
et utilise le [formulaire de synchronisation](https://github.com/N0thyTVOff/PrepaTrack/issues/new?template=sync.yml).
