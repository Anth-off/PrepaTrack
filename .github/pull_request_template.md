<!--
  Le titre de cette PR devient le message de commit dans main après la fusion en
  squash. Il doit suivre les Conventional Commits, sinon le changement
  n'apparaîtra pas dans le changelog.

      feat: ajouter les palettes perdues aux supports
      fix: corriger le chrono qui repartait à zéro après un trajet
      fix!: exclure les aléas du calcul de cadence

  Voir docs/CONTRIBUTING.md
-->

## Ce que fait ce changement

<!-- En une ou deux phrases, du point de vue de l'utilisateur. -->

## Pourquoi

<!-- Le problème constaté, ou le besoin exprimé. -->

## Vérifications

- [ ] `npm test` passe
- [ ] `npm run typecheck` passe
- [ ] `npm run build` passe
- [ ] Testé sur téléphone si l'écran de vacation est touché
- [ ] `npm run db:check` passe si `supabase/` est modifié

## Points d'attention

<!--
  À remplir si le changement touche :
  - un calcul de cadence ou de temps (dire ce qui change dans les chiffres) ;
  - le schéma de base ou les règles de sécurité ;
  - la synchronisation ou le format des données stockées.
  Sinon, supprimer cette section.
-->
