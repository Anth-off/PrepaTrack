#!/usr/bin/env node
/**
 * Installe le schéma PrepaTrack dans la base Supabase.
 *
 * Remplace le copier-coller de `supabase/schema.sql` dans l'éditeur SQL du
 * tableau de bord. Le script est rejouable sans risque : le SQL ne crée que ce
 * qui manque et ne touche jamais aux données existantes.
 *
 *   npm run db:setup
 *
 * L'adresse de connexion est lue dans `.env.local` (ignoré par git) ou dans la
 * variable d'environnement SUPABASE_DB_URL. Elle contient le mot de passe de la
 * base : elle ne doit jamais être versionnée ni collée dans un message.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function readEnvLocal() {
  const file = join(root, '.env.local')
  if (!existsSync(file)) return {}
  const env = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line)
    if (!match) continue
    // Les guillemets encadrants sont tolérés, un mot de passe pouvant contenir
    // des caractères que l'on a naturellement envie de protéger.
    env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return env
}

function fail(message, hint) {
  console.error(`\n✖ ${message}`)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}

const env = { ...readEnvLocal(), ...process.env }
const url = env.SUPABASE_DB_URL

if (!url) {
  fail(
    'Adresse de connexion introuvable.',
    `Dans Supabase : Project Settings → Database → Connection string → onglet URI.
Copie la ligne, remplaces-y [YOUR-PASSWORD] par le mot de passe choisi à la
création du projet, puis crée un fichier .env.local à la racine contenant :

SUPABASE_DB_URL=postgresql://postgres.xxxxx:MOTDEPASSE@aws-0-eu-...pooler.supabase.com:5432/postgres

Ce fichier est déjà ignoré par git : le mot de passe ne partira jamais en ligne.`,
  )
}

// Les fichiers sont appliqués dans cet ordre : les tables de production, puis
// les préparateurs et les règles de rôle qui s'appuient dessus.
const SCHEMA_FILES = ['schema.sql', 'multi-user.sql']

const schemas = SCHEMA_FILES.map((name) => {
  const path = join(root, 'supabase', name)
  if (!existsSync(path)) fail(`Fichier introuvable : ${path}`)
  return { name, sql: readFileSync(path, 'utf8') }
})

/**
 * Supabase signe ses bases avec sa propre autorité (« Supabase Intermediate
 * 2021 CA »), absente du magasin de certificats du système. Sans son certificat
 * racine, la vérification échoue — y compris via le pooler, qui utilise la même
 * autorité. On le charge donc explicitement plutôt que de désactiver le
 * contrôle : le mot de passe de la base transite dans cette connexion.
 */
function loadCa() {
  const candidates = [
    env.SUPABASE_CA_CERT,
    join(root, 'supabase', 'prod-ca-2021.crt'),
    join(root, 'prod-ca-2021.crt'),
  ].filter(Boolean)

  for (const path of candidates) {
    if (!existsSync(path)) continue
    const pem = readFileSync(path, 'utf8')
    if (pem.includes('BEGIN CERTIFICATE')) return { path, pem }
    fail(
      `Le fichier ${path} n'est pas un certificat.`,
      "Il a sans doute été enregistré depuis une page web. Retélécharge-le depuis\nle tableau de bord Supabase : Project Settings → Database → SSL Configuration.",
    )
  }
  return undefined
}

const ca = loadCa()
const insecure = env.SUPABASE_DB_INSECURE === '1'

if (!ca && !insecure) {
  fail(
    'Certificat racine Supabase introuvable.',
    `Supabase signe ses bases avec sa propre autorité, que Windows ne connaît pas.
Il faut donc lui fournir son certificat — une seule fois :

  1. Dans Supabase : Project Settings → Database → SSL Configuration
  2. Clique « Download certificate » (fichier prod-ca-2021.crt)
  3. Place-le dans le dossier supabase/ du projet
  4. Relance : npm run db:setup

À défaut, tu peux appliquer le schéma à la main depuis le SQL Editor du tableau
de bord, en collant le contenu de supabase/schema.sql.`,
  )
}

if (insecure) {
  console.warn(
    "⚠ Vérification du certificat désactivée (SUPABASE_DB_INSECURE=1).\n" +
      "  La connexion reste chiffrée, mais l'identité du serveur n'est plus\n" +
      '  contrôlée. À éviter sur un réseau public.\n',
  )
}

const client = new pg.Client({
  connectionString: url,
  ssl: ca ? { ca: ca.pem, rejectUnauthorized: true } : { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
})

if (ca) console.log('Certificat TLS Supabase chargé.')

console.log('Connexion à la base…')

try {
  await client.connect()
} catch (error) {
  const message = String(error?.message ?? error)
  if (/password authentication failed/i.test(message)) {
    fail(
      'Mot de passe refusé.',
      "Vérifie le mot de passe dans SUPABASE_DB_URL. Il se réinitialise dans\nProject Settings → Database → Reset database password.",
    )
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    fail('Serveur introuvable.', "Vérifie l'adresse copiée et ta connexion internet.")
  }
  if (/self.signed|certificate|SELF_SIGNED/i.test(message)) {
    fail(
      'Certificat TLS refusé.',
      ca
        ? `Le certificat fourni (${ca.path}) ne valide pas ce serveur. Retélécharge-le
depuis Project Settings → Database → SSL Configuration de CE projet.`
        : `Il manque le certificat racine de Supabase.
Télécharge-le dans Project Settings → Database → SSL Configuration et place
prod-ca-2021.crt dans le dossier supabase/ du projet.`,
    )
  }
  // Les erreurs du pilote peuvent contenir l'URI PostgreSQL complète. On les
  // utilise pour orienter le diagnostic sans jamais les recopier dans le terminal.
  fail(
    'Connexion impossible.',
    'Vérifie la chaîne SUPABASE_DB_URL, le certificat TLS et la disponibilité du projet.',
  )
}

try {
  for (const schema of schemas) {
    console.log(`Application de ${schema.name}…`)
    await client.query(schema.sql)
  }

  // Contrôle explicite : « aucune erreur » ne prouve pas que les tables sont là.
  const { rows } = await client.query(`
    select tablename,
           rowsecurity,
           (select count(*)
              from pg_policies p
             where p.schemaname = t.schemaname
               and p.tablename = t.tablename) as policies
      from pg_tables t
     where schemaname = 'public'
       and tablename in ('workdays', 'orders', 'order_pallets', 'segments', 'colis_events', 'stock_shortages', 'preparers')
     order by tablename
  `)

  if (rows.length !== 7) {
    fail(
      `Seulement ${rows.length} table(s) sur 7 ont été créées.`,
      'Relance la commande, ou applique les fichiers de supabase/ à la main depuis le SQL Editor.',
    )
  }

  const withoutRls = rows.filter((r) => !r.rowsecurity)
  if (withoutRls.length > 0) {
    fail(
      `Sécurité RLS inactive : ${withoutRls.map((r) => r.tablename).join(', ')}.`,
      'Le déploiement est interrompu avant que le nouveau code accède à ces tables.',
    )
  }

  const unprotected = rows.filter((r) => Number(r.policies) === 0)
  if (unprotected.length > 0) {
    fail(
      `Tables sans règle de sécurité : ${unprotected.map((r) => r.tablename).join(', ')}.`,
      "Les données seraient lisibles par n'importe qui. Relance la commande.",
    )
  }
  const requiredShortageColumns = [
    'id', 'user_id', 'workday_id', 'order_id', 'at', 'quantity',
    'resolved', 'updated_at', 'deleted_at',
  ]
  const { rows: shortageColumns } = await client.query(`
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'stock_shortages'
  `)
  const availableShortageColumns = new Set(shortageColumns.map((row) => row.column_name))
  const missingShortageColumns = requiredShortageColumns.filter(
    (column) => !availableShortageColumns.has(column),
  )
  if (missingShortageColumns.length > 0) {
    fail(
      `Colonnes manquantes dans stock_shortages : ${missingShortageColumns.join(', ')}.`,
      'Complète la migration additive avant de déployer cette version.',
    )
  }

  const { rowCount: shortageIndexes } = await client.query(`
    select 1
      from pg_indexes
     where schemaname = 'public'
       and tablename = 'stock_shortages'
       and indexname = 'stock_shortages_sync_idx'
  `)
  if (shortageIndexes !== 1) {
    fail(
      "L'index stock_shortages_sync_idx est absent.",
      'Relance la migration avant de déployer cette version.',
    )
  }

  const { rows: shortageForeignKeys } = await client.query(`
    select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'stock_shortages'
       and c.contype = 'f'
  `)
  const ownsShortages = shortageForeignKeys.some((row) =>
    /foreign key \(user_id\) references auth\.users\(id\) on delete restrict/i.test(row.definition),
  )
  if (!ownsShortages) {
    fail(
      'La clé étrangère sécurisée de stock_shortages vers auth.users est absente.',
      'Applique supabase/multi-user.sql avant de déployer cette version.',
    )
  }

  // Premier gestionnaire : sans lui, aucun badge ne pourrait être déclaré et
  // personne ne pourrait se connecter.
  const badge = (env.MANAGER_BADGE ?? '').trim()
  const name = (env.MANAGER_NAME ?? '').trim()

  if (badge) {
    if (!/^\d{4,12}$/.test(badge)) {
      fail('MANAGER_BADGE doit être un numéro de badge (4 à 12 chiffres).')
    }
    await client.query('select public.seed_manager($1, $2)', [badge, name || `Badge ${badge}`])
    console.log('\nGestionnaire initial déclaré.')
  }

  const { rows: managers } = await client.query(
    "select badge, name, user_id from public.preparers where role = 'manager' and active order by badge",
  )

  console.log('\n✔ Base prête.')
  for (const row of rows) {
    console.log(`  ${row.tablename} — ${row.policies} règle(s) de sécurité`)
  }

  if (managers.length === 0) {
    console.log(
      `\n⚠ Aucun gestionnaire déclaré : personne ne pourra ajouter de préparateur.
  Ajoute ces deux lignes dans .env.local puis relance la commande :

  MANAGER_BADGE=1234567
  MANAGER_NAME=Ton Nom`,
    )
  } else {
    const pending = managers.filter((manager) => !manager.user_id).length
    console.log(`\nGestionnaires actifs : ${managers.length}`)
    if (pending > 0) console.log(`Comptes restant à initialiser : ${pending}`)
    console.log(
      `\nProchaine étape : dans l'app, Réglages → Synchro, colle l'adresse du projet
et la clé « anon public », puis connecte-toi avec ton badge et un code personnel.`,
    )
  }
} catch {
  // Une erreur SQL peut inclure une valeur métier ou un extrait de requête. Le
  // détail n'est donc pas journalisé par défaut dans un terminal potentiellement partagé.
  fail(
    "Échec de l'application du schéma.",
    'Vérifie que les fichiers SQL correspondent à la dernière version puis relance la commande.',
  )
} finally {
  await client.end()
}
