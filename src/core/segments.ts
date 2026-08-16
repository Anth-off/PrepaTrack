import type { KnownSegmentType, SegmentType } from './types'

/**
 * Catégorie analytique d'un segment. C'est elle qui décide dans quel
 * dénominateur le temps atterrit lors du calcul des trois cadences.
 */
export type SegmentCategory =
  /** Le prélèvement lui-même : le seul temps réellement productif. */
  | 'productive'
  /** Nécessaire au bon déroulement mais sans colis prélevé. */
  | 'necessary'
  /** Temps subi ou perdu, la cible des recommandations. */
  | 'waste'
  /** Pause réglementaire, exclue du temps de travail. */
  | 'break'
  /** Cadre de journée hors commande. */
  | 'overhead'

export interface SegmentDef {
  label: string
  short: string
  emoji: string
  category: SegmentCategory
  /** Un segment d'interruption suspend le segment en cours et le reprend après. */
  interruption: boolean
  /** Classe Tailwind de la couleur, utilisée par la frise et les graphiques. */
  color: string
  /** Couleur brute pour les rendus non-Tailwind (frise en dégradé, exports). */
  hex: string
}

/** Définitions livrées. Pour résoudre un type quelconque, voir `segmentDef()`. */
export const SEGMENTS: Record<KnownSegmentType, SegmentDef> = {
  briefing: {
    label: 'Briefing',
    short: 'Briefing',
    emoji: '📋',
    category: 'overhead',
    interruption: false,
    color: 'bg-violet-500',
    hex: '#8b5cf6',
  },
  poste_prep: {
    label: 'Prépa poste',
    short: 'Prépa poste',
    emoji: '🎧',
    category: 'overhead',
    interruption: false,
    color: 'bg-violet-400',
    hex: '#a78bfa',
  },
  idle: {
    label: 'Temps mort',
    short: 'Attente',
    emoji: '⏸️',
    category: 'waste',
    interruption: false,
    color: 'bg-slate-600',
    hex: '#475569',
  },
  cleanup: {
    label: 'Rangement / nettoyage',
    short: 'Rangement',
    emoji: '🧹',
    category: 'overhead',
    interruption: false,
    color: 'bg-teal-500',
    hex: '#14b8a6',
  },

  order_setup: {
    label: 'Recherche palette + étiquette',
    short: 'Prépa cde',
    emoji: '🏷️',
    category: 'necessary',
    interruption: false,
    color: 'bg-sky-500',
    hex: '#0ea5e9',
  },
  picking: {
    label: 'Préparation',
    short: 'Prépa',
    emoji: '📦',
    category: 'productive',
    interruption: false,
    color: 'bg-emerald-500',
    hex: '#10b981',
  },
  wrapping: {
    label: 'Filmage',
    short: 'Filmage',
    emoji: '🎞️',
    category: 'necessary',
    interruption: false,
    color: 'bg-cyan-500',
    hex: '#06b6d4',
  },
  docking: {
    label: 'Mise à quai',
    short: 'Quai',
    emoji: '🚚',
    category: 'necessary',
    interruption: false,
    color: 'bg-blue-500',
    hex: '#3b82f6',
  },

  travel: {
    label: 'Trajet',
    short: 'Trajet',
    emoji: '🚜',
    category: 'waste',
    interruption: true,
    color: 'bg-amber-500',
    hex: '#f59e0b',
  },
  toilet: {
    label: 'Pause toilettes',
    short: 'WC',
    emoji: '🚻',
    category: 'waste',
    interruption: true,
    color: 'bg-orange-400',
    hex: '#fb923c',
  },
  pallet_change: {
    label: 'Changement de palette / dépose',
    short: 'Palette',
    emoji: '🔄',
    category: 'necessary',
    interruption: true,
    color: 'bg-indigo-400',
    hex: '#818cf8',
  },
  incident_material: {
    label: 'Problème matériel',
    short: 'Matériel',
    emoji: '🔧',
    category: 'waste',
    interruption: true,
    color: 'bg-rose-500',
    hex: '#f43f5e',
  },
  incident_wait: {
    label: 'Attente / blocage',
    short: 'Attente',
    emoji: '⏳',
    category: 'waste',
    interruption: true,
    color: 'bg-red-500',
    hex: '#ef4444',
  },
  incident_human: {
    label: 'Aide collègue / chef',
    short: 'Humain',
    emoji: '👥',
    category: 'waste',
    interruption: true,
    color: 'bg-pink-500',
    hex: '#ec4899',
  },
  incident_bug: {
    label: 'Bug application / réseau',
    short: 'Bug / réseau',
    emoji: '🐛',
    category: 'waste',
    interruption: true,
    color: 'bg-red-500',
    hex: '#ef4444',
  },
  incident_discussion: {
    label: 'Discussion',
    short: 'Discussion',
    emoji: '💬',
    category: 'waste',
    interruption: true,
    color: 'bg-sky-500',
    hex: '#0ea5e9',
  },
  incident_forklift: {
    label: 'Cariste',
    short: 'Cariste',
    emoji: '🚜',
    category: 'waste',
    interruption: true,
    color: 'bg-amber-500',
    hex: '#f59e0b',
  },
  incident_drink: {
    label: 'Boire',
    short: 'Boire',
    emoji: '💧',
    category: 'waste',
    interruption: true,
    color: 'bg-cyan-500',
    hex: '#06b6d4',
  },
  incident_label: {
    label: 'Étiquette absente ou illisible',
    short: 'Étiquette',
    emoji: '🏷️',
    category: 'waste',
    interruption: true,
    color: 'bg-purple-500',
    hex: '#a855f7',
  },
  incident_supplies: {
    label: 'Manque de consommables : film, carton ou étiquette',
    short: 'Consommables',
    emoji: '📦',
    category: 'waste',
    interruption: true,
    color: 'bg-orange-600',
    hex: '#ea580c',
  },
  incident_restock_wait: {
    label: 'Attente de réapprovisionnement',
    short: 'Réappro',
    emoji: '📥',
    category: 'waste',
    interruption: true,
    color: 'bg-lime-500',
    hex: '#84cc16',
  },
  incident_colleague_blocked: {
    label: 'Bloqué par des collègues',
    short: 'Collègues',
    emoji: '🚧',
    category: 'waste',
    interruption: true,
    color: 'bg-amber-600',
    hex: '#d97706',
  },
  incident_support_inverted: {
    label: 'Support inversé — validation du chef nécessaire',
    short: 'Support inversé',
    emoji: '🔃',
    category: 'waste',
    interruption: true,
    color: 'bg-violet-500',
    hex: '#8b5cf6',
  },
  incident_vmax_invalid: {
    label: 'Support VMAX non valide — passage aux contenants',
    short: 'VMAX invalide',
    emoji: '⛔',
    category: 'waste',
    interruption: true,
    color: 'bg-red-600',
    hex: '#dc2626',
  },
  incident_wrong_support: {
    label: 'Mauvais support — remplacement nécessaire',
    short: 'Mauvais support',
    emoji: '↩️',
    category: 'waste',
    interruption: true,
    color: 'bg-orange-500',
    hex: '#f97316',
  },
  incident_support_unavailable: {
    label: 'Support absent ou abîmé',
    short: 'Support indispo',
    emoji: '🪵',
    category: 'waste',
    interruption: true,
    color: 'bg-yellow-700',
    hex: '#a16207',
  },
  incident_zone_blocked: {
    label: 'Allée ou zone bloquée',
    short: 'Zone bloquée',
    emoji: '🚫',
    category: 'waste',
    interruption: true,
    color: 'bg-rose-600',
    hex: '#e11d48',
  },
  incident_location_error: {
    label: 'Emplacement erroné ou vide',
    short: 'Emplacement',
    emoji: '📍',
    category: 'waste',
    interruption: true,
    color: 'bg-fuchsia-500',
    hex: '#d946ef',
  },
  incident_product_damaged: {
    label: 'Produit endommagé',
    short: 'Produit abîmé',
    emoji: '💥',
    category: 'waste',
    interruption: true,
    color: 'bg-red-500',
    hex: '#ef4444',
  },
  incident_quality_wait: {
    label: 'Attente de contrôle qualité',
    short: 'Contrôle',
    emoji: '🔎',
    category: 'waste',
    interruption: true,
    color: 'bg-blue-500',
    hex: '#3b82f6',
  },
  incident_safety_cleanup: {
    label: 'Casse, nettoyage ou danger',
    short: 'Casse / danger',
    emoji: '⚠️',
    category: 'waste',
    interruption: true,
    color: 'bg-orange-600',
    hex: '#ea580c',
  },
  incident_other: {
    label: 'Autre aléa',
    short: 'Autre',
    emoji: '❓',
    category: 'waste',
    interruption: true,
    color: 'bg-slate-500',
    hex: '#64748b',
  },

  break_10: {
    label: 'Pause 10 min',
    short: 'Pause 10',
    emoji: '☕',
    category: 'break',
    interruption: true,
    color: 'bg-yellow-600',
    hex: '#ca8a04',
  },
  break_30: {
    label: 'Pause 30 min',
    short: 'Pause 30',
    emoji: '🍽️',
    category: 'break',
    interruption: true,
    color: 'bg-yellow-700',
    hex: '#a16207',
  },
}

/** Segments qui composent le déroulement d'une commande. */
export const ORDER_PHASES: SegmentType[] = ['order_setup', 'picking', 'wrapping', 'docking']

export const INCIDENT_TYPES: SegmentType[] = [
  'incident_material',
  'incident_bug',
  'incident_colleague_blocked',
  'incident_wait',
  'incident_human',
  'incident_discussion',
  'incident_forklift',
  'incident_support_inverted',
  'incident_vmax_invalid',
  'incident_wrong_support',
  'incident_support_unavailable',
  'incident_zone_blocked',
  'incident_label',
  'incident_supplies',
  'incident_restock_wait',
  'incident_location_error',
  'incident_product_damaged',
  'incident_quality_wait',
  'incident_safety_cleanup',
  'incident_drink',
  'incident_other',
]

export const BREAK_TYPES: SegmentType[] = ['break_10', 'break_30']

// --- Aléas ajoutés par l'utilisateur --------------------------------------

/**
 * Définitions des aléas personnalisés, alimentées au chargement des réglages.
 *
 * Un registre plutôt qu'une propriété passée d'écran en écran : `SEGMENTS` est
 * consulté depuis une vingtaine d'endroits, dont des fonctions de calcul pures
 * qui n'ont aucune raison de recevoir les préférences d'affichage.
 */
let customDefs: Record<string, SegmentDef> = {}

/** Palette de repli, pour que deux aléas ne se ressemblent pas trop. */
const CUSTOM_COLORS = [
  { color: 'bg-fuchsia-500', hex: '#d946ef' },
  { color: 'bg-lime-500', hex: '#84cc16' },
  { color: 'bg-orange-600', hex: '#ea580c' },
  { color: 'bg-purple-500', hex: '#a855f7' },
]

export function registerCustomIncidents(
  list: { key: string; label: string; emoji: string }[],
): void {
  const next: Record<string, SegmentDef> = {}
  list.forEach((incident, index) => {
    // Les types livrés gardent leur définition d'origine : un utilisateur ne
    // doit pas pouvoir redéfinir la catégorie d'un segment de prélèvement.
    if (incident.key in SEGMENTS) return
    const palette = CUSTOM_COLORS[index % CUSTOM_COLORS.length]
    next[incident.key] = {
      label: incident.label,
      short: incident.label.slice(0, 10),
      emoji: incident.emoji,
      category: 'waste',
      interruption: true,
      ...palette,
    }
  })
  customDefs = next
}

/** Définition de repli : un type inconnu doit rester affichable. */
const UNKNOWN: SegmentDef = {
  label: 'Aléa supprimé',
  short: 'Aléa',
  emoji: '⚠️',
  category: 'waste',
  interruption: true,
  color: 'bg-slate-500',
  hex: '#64748b',
}

/**
 * Résout la définition d'un segment. **Ne renvoie jamais `undefined`** : c'est
 * ce qui garantit qu'un aléa supprimé des réglages ne fait pas planter l'écran
 * de bilan des journées où il avait servi.
 */
export function segmentDef(type: SegmentType): SegmentDef {
  return SEGMENTS[type as KnownSegmentType] ?? customDefs[type] ?? UNKNOWN
}

export function isInterruption(type: SegmentType): boolean {
  return segmentDef(type).interruption
}

export function isOrderPhase(type: SegmentType): boolean {
  return ORDER_PHASES.includes(type)
}

export function isBreak(type: SegmentType): boolean {
  return segmentDef(type).category === 'break'
}

export function categoryOf(type: SegmentType): SegmentCategory {
  return segmentDef(type).category
}

export function labelOf(type: SegmentType): string {
  return segmentDef(type).label
}
