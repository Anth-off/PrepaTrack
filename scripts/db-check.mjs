#!/usr/bin/env node
/**
 * Validation des fichiers de schéma, **sans aucune connexion**.
 *
 * Le déploiement de la base passe par `npm run db:setup`, qui exige des
 * identifiants de production. Une chaîne d'intégration ne doit ni les détenir
 * ni toucher à la base : ce contrôle se limite donc à ce qui est vérifiable
 * hors ligne — les fichiers existent, ne sont pas vides, et contiennent bien
 * les tables et les règles de sécurité attendues.
 *
 * Il attrape le cas le plus coûteux : un schéma amputé de ses règles de
 * sécurité, qui rendrait toutes les données lisibles par n'importe quel compte.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

function check(condition, message) {
  if (!condition) problems.push(message)
}

// --- Fichiers de schéma ----------------------------------------------------

const files = ['schema.sql', 'multi-user.sql']
const sql = {}

for (const name of files) {
  const path = join(root, 'supabase', name)
  if (!existsSync(path)) {
    problems.push(`supabase/${name} est introuvable`)
    continue
  }
  sql[name] = readFileSync(path, 'utf8')
  check(sql[name].trim().length > 0, `supabase/${name} est vide`)
}

if (problems.length === 0) {
  const all = Object.values(sql).join('\n')

  // Tables de production.
  for (const table of ['workdays', 'orders', 'order_pallets', 'segments', 'colis_events', 'stock_shortages', 'coaching_alerts', 'preparers']) {
    check(
      new RegExp(`create table if not exists public\\.${table}\\b`, 'i').test(all),
      `la table « ${table} » n'est plus créée par le schéma`,
    )
  }

  // Sécurité au niveau ligne : c'est elle qui isole les données de chacun.
  for (const table of ['workdays', 'orders', 'order_pallets', 'segments', 'colis_events', 'stock_shortages', 'coaching_alerts', 'preparers']) {
    check(
      new RegExp(`alter table public\\.${table} enable row level security`, 'i').test(all),
      `la sécurité au niveau ligne n'est plus activée sur « ${table} »`,
    )
  }

  check(
    /create policy/i.test(all),
    'aucune règle de sécurité définie : les données seraient exposées',
  )

  // Le rôle gestionnaire doit rester vérifié côté base, jamais côté interface.
  check(
    /function public\.is_manager\(\)/i.test(all),
    'la fonction is_manager() a disparu : les rôles ne seraient plus vérifiés en base',
  )

  // Un compte ne doit pas pouvoir se créer sans badge déclaré au préalable.
  check(
    /function public\.link_preparer\(\)/i.test(all),
    "le déclencheur de rattachement a disparu : l'inscription deviendrait libre",
  )

  // Une suppression de compte ne doit pas emporter la production associée.
  check(
    /on delete restrict/i.test(all),
    'la protection contre la suppression en cascade a disparu',
  )

  // `schema.sql` déclare les tables de production en cascade ; `multi-user.sql`
  // convertit ensuite ces contraintes en « restrict ». C'est cette conversion
  // qui empêche qu'une suppression de compte efface une production entière —
  // sa disparition serait bien plus grave que les cascades initiales.
  const declaresCascade = /references auth\.users[^;]*on delete cascade/i.test(
    sql['schema.sql'] ?? '',
  )
  const convertsToRestrict =
    /foreign key \(user_id\)[\s\S]{0,120}on delete restrict/i.test(sql['multi-user.sql'] ?? '')

  check(
    !declaresCascade || convertsToRestrict,
    'les tables de production restent en « on delete cascade » : supprimer un compte effacerait sa production',
  )
}

// --- Script d'application --------------------------------------------------

const setup = join(root, 'scripts', 'db-setup.mjs')
check(existsSync(setup), 'scripts/db-setup.mjs est introuvable')

// --- Résultat --------------------------------------------------------------

for (const note of notes) console.log(`  ~ ${note}`)

if (problems.length > 0) {
  console.error('\n✖ Schéma de base invalide :')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('✔ Schéma de base cohérent (tables, règles de sécurité, rôles, déclencheurs).')
console.log('  Aucune connexion effectuée : l\'application réelle passe par « npm run db:setup ».')
