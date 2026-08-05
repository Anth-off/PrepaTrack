# iOS et TestFlight

PrepaTrack conserve son application React/PWA et l'embarque dans une application
iOS native avec Capacitor. La PWA reste déployable indépendamment.

## Ce qui est automatisé

- `npm run ios:sync` construit la PWA puis met à jour le projet Xcode ;
- chaque PR compile une version iOS non signée sur un runner macOS GitHub ;
- le workflow **TestFlight** signe, archive et envoie le build à App Store Connect ;
- l'envoi TestFlight est exclusivement manuel (`workflow_dispatch`).

## Configuration Apple unique

1. Dans **Certificates, Identifiers & Profiles**, créer l'App ID explicite
   `com.n0thytvoff.prepatrack`.
2. Dans **App Store Connect > Apps**, créer l'app **PrepaTrack** avec ce Bundle ID.
3. Dans **Users and Access > Integrations > App Store Connect API**, créer une clé
   d'équipe ayant le rôle `App Manager`, puis télécharger son fichier `.p8`. Le
   fichier n'est téléchargeable qu'une fois.
4. Dans le dépôt GitHub, créer l'environnement `app-store-connect`. Une approbation
   manuelle peut y être exigée avant chaque envoi.
5. Ajouter à cet environnement les secrets suivants :

| Secret | Valeur |
|---|---|
| `APPLE_TEAM_ID` | identifiant d'équipe Apple à 10 caractères |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID affiché avec la clé API |
| `APP_STORE_CONNECT_KEY_ID` | Key ID de la clé API |
| `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | contenu du `.p8` encodé en Base64 sur une seule ligne |

Sous PowerShell, encoder le fichier sans afficher la clé :

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('AuthKey_XXXXXXXXXX.p8')) | Set-Clipboard
```

Coller directement le presse-papiers dans le secret GitHub. Ne jamais committer le
fichier `.p8`, sa version Base64, un mot de passe Apple ou un code de validation.

## Envoyer un build

Ouvrir **Actions > TestFlight > Run workflow** depuis `main`. Le numéro de build est
le numéro d'exécution GitHub, donc il augmente automatiquement. La version publique
provient de `package.json`.

Après traitement par Apple, le build apparaît dans l'onglet TestFlight. Le premier
test interne ne nécessite pas de revue App Store ; une bêta externe nécessite la
validation Beta App Review d'Apple.

## Développement local

Le build web fonctionne sur Windows. L'ouverture du projet natif nécessite Xcode :

```bash
npm ci
npm run ios:sync
npx cap open ios
```

Sans Mac, la vérification Xcode et l'envoi sont assurés par GitHub Actions.
