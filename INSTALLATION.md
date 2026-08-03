# Installer PrepaTrack

Trois étapes : tester sur le PC, mettre en ligne, installer sur l'iPhone.
Aucune connaissance technique n'est nécessaire, il suffit de suivre dans l'ordre.

---

## 1. Tester sur le PC

Ouvre un terminal dans le dossier `prepatrack` et lance :

```bash
npm run dev
```

Puis ouvre <http://localhost:5173> dans ton navigateur. Pour simuler l'iPhone : `F12`,
puis l'icône téléphone/tablette en haut de la fenêtre qui s'ouvre.

Pour arrêter : `Ctrl + C` dans le terminal.

---

## 2. Mettre en ligne (gratuit, une seule fois)

L'hébergement est **obligatoire** : sans adresse en `https://`, iOS refuse d'installer
l'app sur l'écran d'accueil, et sans installation Safari efface les données au bout de
7 jours. Ce n'est donc pas une étape optionnelle.

### 2.1 Créer le compte

1. Va sur <https://vercel.com/signup>
2. Choisis « Continue with Email », mets ton adresse, valide le lien reçu par mail
3. C'est tout — le forfait gratuit suffit très largement ici

### 2.2 Envoyer l'app

Dans le terminal, toujours dans le dossier `prepatrack` :

```bash
npx vercel login
```

Saisis la même adresse mail, puis valide le lien reçu. Ensuite :

```bash
npx vercel --prod
```

Réponds aux questions posées :

| Question | Réponse |
|---|---|
| Set up and deploy ? | `y` |
| Which scope ? | valide (Entrée) |
| Link to existing project ? | `n` |
| What's your project's name ? | `prepatrack` |
| In which directory is your code ? | valide (Entrée) |
| Want to modify these settings ? | `n` |

À la fin, une adresse s'affiche, du type
`https://prepatrack-xxxx.vercel.app`. **Note-la, c'est l'adresse de ton app.**

> Pour publier une mise à jour plus tard, il suffit de relancer `npx vercel --prod`
> depuis ce dossier.

---

## 3. Activer la synchro iPhone ↔ PC (gratuit)

Sans cette étape, l'app fonctionne parfaitement mais chaque appareil garde ses propres
données : ton PC ne verra pas ta prod de la journée.

### 3.1 Créer la base

1. Va sur <https://supabase.com/dashboard> et crée un compte (« Sign in with Email »)
2. **New project** : nomme-le `prepatrack`, choisis une région en Europe (Frankfurt ou
   Paris), et **note bien le mot de passe** de la base qu'il te demande de créer
3. Attends 1 à 2 minutes que le projet soit prêt

### 3.2 Créer les tables (automatique)

1. Dans Supabase : **Project Settings** → **Database** → **Connection string**, onglet
   **URI**. Copie la ligne affichée.
2. À la racine du projet, crée un fichier nommé `.env.local` contenant :

   ```
   SUPABASE_DB_URL=colle_ici_la_ligne_copiée
   ```

   Remplace `[YOUR-PASSWORD]` dans cette ligne par le mot de passe noté à l'étape 3.1.
   Ce fichier est ignoré par git : le mot de passe ne partira jamais en ligne.

3. Déclare le premier gestionnaire en ajoutant deux lignes à `.env.local` :

   ```
   MANAGER_BADGE=1234567
   MANAGER_NAME=Ton Nom
   ```

   Sans lui, personne ne pourrait déclarer les badges de l'équipe. Son compte sera
   créé à sa première connexion dans l'app.

4. Récupère le certificat de sécurité, une seule fois, depuis les réglages de base de
   données du projet (section SSL). Place le fichier `prod-ca-2021.crt` obtenu dans le
   dossier `supabase/` du projet.

   Supabase signe ses bases avec sa propre autorité de certification, que Windows ne
   connaît pas. Sans ce fichier, la connexion est refusée — c'est normal et ça vaut
   aussi pour le pooler.

5. Lance :

   ```bash
   npm run db:setup
   ```

Le script crée les tables et les règles de sécurité, puis vérifie que tout est en place.
Tu dois voir « Base prête » suivi des quatre tables. Tu peux le relancer autant de fois
que tu veux, il ne touche jamais aux données déjà enregistrées.

> Si tu préfères le faire à la main, ou si le certificat pose problème : **SQL Editor**
> → **New query**, colle tout le contenu de `supabase/schema.sql` et clique **Run**.
> Le résultat est identique.

### 3.3 Désactiver la confirmation par e-mail

La connexion se fait par identifiant et mot de passe, sans aucun envoi de message. Il
reste à dire à Supabase de ne pas réclamer de confirmation d'adresse.

Dans la section **Authentication** du projet, réglages des fournisseurs de connexion,
partie **Email** : désactive **« Confirm email »** (parfois nommé « Confirm email
address »), puis enregistre.

Sans ça, la création du compte réussit mais la session ne s'ouvre pas, et l'app te le
signalera explicitement.

> Pourquoi pas de code par e-mail : le service d'envoi par défaut de Supabase est limité à
> 2 messages par heure et ne dessert que les membres de l'organisation. Beaucoup de pièces
> mobiles pour un seul utilisateur sur deux appareils.

### 3.4 Relier l'app

1. Menu → **Project Settings** → **API**
2. Copie **Project URL** (`https://xxxxx.supabase.co`) et la clé **anon public**
3. Dans PrepaTrack : onglet **Réglages** → section **Synchro iPhone ↔ PC**
4. Colle les deux valeurs, **Enregistrer**
5. Saisis ton **numéro de badge** et un **code personnel à 6 chiffres**, puis
   **Première connexion — définir mon code**. Les fois suivantes : **Se connecter**.

À refaire **une fois sur chaque appareil**, avec le même badge et le même code. La
session reste ouverte : rien à ressaisir au travail.

### 4.1 Ajouter les préparateurs

Une fois connecté en gestionnaire, un onglet **Équipe** apparaît. Pour chaque
préparateur : **+ Ajouter**, son numéro de badge et son nom.

Il choisira lui-même son code à sa première connexion — tu n'as pas à le connaître, et
tu ne peux pas le lire. En cas d'oubli, tu peux lui en redéfinir un depuis sa fiche.

Un badge non déclaré ne peut pas créer de compte : c'est ce qui empêche n'importe qui
de s'inscrire, ou de prendre le badge d'un collègue.

### 4.2 Qui voit quoi

| | Préparateur | Gestionnaire |
|---|---|---|
| Sa propre production | ✓ | ✓ |
| Production des autres | — | ✓ |
| Ajouter / désactiver un compte | — | ✓ |
| Redéfinir un code oublié | — | ✓ |
| Corriger les données d'un autre | — | ✓ |

Ces règles sont appliquées **par la base de données**, pas par l'interface : un
préparateur qui contournerait l'app n'obtiendrait rien de plus.

> La clé « anon » est publique par conception : ce sont les règles de sécurité au niveau
> ligne, installées par le script SQL, qui protègent tes données. Personne d'autre que toi
> ne peut les lire, même en connaissant cette clé.

### Comment savoir que ça marche

Dans **Réglages → Synchro**, l'état affiche « À jour » et l'heure de la dernière synchro.
Le compteur « en attente » indique ce qui n'est pas encore remonté — c'est **normal** qu'il
monte pendant toute ta vacation, l'entrepôt n'a pas de réseau. Tout part dès que tu
retrouves de la connexion.

---

## 4. Installer sur l'iPhone

**C'est l'étape la plus importante, ne la saute pas.** Une app simplement ouverte dans
Safari perd ses données au bout de 7 jours sans visite ; une app installée sur l'écran
d'accueil les garde.

1. Ouvre **Safari** (pas Chrome : sur iOS, seul Safari sait installer une app)
2. Va sur ton adresse `https://prepatrack-xxxx.vercel.app`
3. Appuie sur le bouton **Partager** (le carré avec une flèche vers le haut, en bas)
4. Fais défiler et choisis **« Sur l'écran d'accueil »**
5. Nomme-la `PrepaTrack`, puis **Ajouter**

L'icône orange apparaît sur ton écran d'accueil. Lance-la **depuis cette icône** à partir
de maintenant, jamais depuis Safari.

### Autoriser les alertes sonores

Au premier lancement, appuie une fois n'importe où dans l'app : iOS n'autorise le son
qu'après une première interaction. Les alertes de fin de pause fonctionneront ensuite.

---

## 5. Vérifier que le hors ligne marche

Avant de compter dessus au travail, teste-le une fois :

1. Lance l'app depuis l'icône de l'écran d'accueil
2. Active le **mode avion**
3. Ferme complètement l'app (glisse vers le haut) et relance-la
4. Elle doit s'ouvrir normalement et te laisser lancer une journée, saisir des commandes,
   tout enregistrer

Si ça marche en mode avion, ça marchera dans l'entrepôt.

5. Désactive le mode avion : dans **Réglages → Synchro**, le compteur « en attente »
   doit retomber à zéro tout seul en quelques secondes

---

## À savoir sur iOS

- **Pas de vibration.** Apple n'expose pas la vibration aux applications web. Les alertes
  de fin de pause et de chrono oublié passent donc par un **bandeau de couleur plein
  écran et un bip sonore**.
- **Les notifications** hors de l'app nécessitent iOS 16.4 ou plus et l'app installée sur
  l'écran d'accueil.
- **Le chrono ne « tourne » pas en arrière-plan** — et c'est voulu. L'app n'enregistre que
  des heures de début et de fin, et recalcule les durées à l'affichage. Écran verrouillé,
  téléphone en veille, app fermée par iOS, batterie vide : au retour les chiffres sont
  exacts à la seconde près.

---

## Détail technique à corriger sur ton PC

Si ton fichier `C:\Users\utilisateur\.npmrc` contient la ligne `os = "linux"`, elle fait croire à
npm qu'il tourne sous Linux, et l'empêche d'installer certains composants réservés à
Windows — c'est ce qui a fait échouer la première installation ici, et ça se reproduira
sur tous tes projets JavaScript.

Si tu n'as pas mis cette ligne volontairement (pour un usage Docker ou WSL), supprime-la
du fichier. Sinon, il faudra ajouter `--os=win32` à chaque `npm install`. Dis-moi si tu
veux que je m'en occupe.
