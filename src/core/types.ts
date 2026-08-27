/**
 * Modèle de données PrepaTrack.
 *
 * Règle fondamentale : la timeline d'une journée est une suite de segments
 * STRICTEMENT LINÉAIRES ET NON CHEVAUCHANTS. Un seul segment est ouvert à la
 * fois. Lancer un trajet pendant une prépa ferme le segment `picking` et en
 * ouvre un `travel` ; à la fermeture du trajet, un nouveau segment `picking`
 * reprend. La somme des durées est donc toujours exactement égale au temps de
 * présence, sans double comptage ni trou possible.
 */

/** Types livrés avec l'application, connus à la compilation. */
export type KnownSegmentType =
  // --- Cadre de la journée -------------------------------------------------
  | 'briefing'
  | 'poste_prep'
  | 'idle'
  | 'cleanup'
  // --- Déroulement d'une commande -----------------------------------------
  | 'order_setup' // recherche palette + étiquette
  | 'picking' // prélèvement
  | 'wrapping' // filmage
  | 'docking' // mise à quai
  // --- Interruptions -------------------------------------------------------
  | 'travel'
  | 'toilet'
  | 'pallet_change'
  | 'incident_material'
  | 'incident_wait'
  | 'incident_human'
  | 'incident_bug'
  | 'incident_discussion'
  | 'incident_forklift'
  | 'incident_drink'
  | 'incident_label'
  | 'incident_supplies'
  | 'incident_restock_wait'
  | 'incident_colleague_blocked'
  | 'incident_support_inverted'
  | 'incident_vmax_invalid'
  | 'incident_wrong_support'
  | 'incident_support_unavailable'
  | 'incident_zone_blocked'
  | 'incident_location_error'
  | 'incident_product_damaged'
  | 'incident_quality_wait'
  | 'incident_safety_cleanup'
  | 'incident_other'
  // --- Pauses réglementaires ----------------------------------------------
  | 'break_10'
  | 'break_30'

/**
 * Type d'un segment : l'un des types livrés, ou la clé d'un aléa ajouté par
 * l'utilisateur. `(string & {})` élargit l'union sans perdre l'autocomplétion
 * sur les types connus.
 *
 * Corollaire : `SEGMENTS[type]` peut être `undefined`. Toute résolution doit
 * passer par `segmentDef()`, qui renvoie toujours une définition exploitable.
 */
export type SegmentType = KnownSegmentType | (string & {})

export type OrderType = 'normale' | 'urbaine' | 'geprocor'

export type SupportKind = 'ipp' | 'europe' | 'vrac' | 'vmax' | 'demi' | 'perdue'

export type Supports = Record<SupportKind, number>

export const EMPTY_SUPPORTS: Supports = {
  ipp: 0,
  europe: 0,
  vrac: 0,
  vmax: 0,
  demi: 0,
  perdue: 0,
}

/** État de synchronisation d'une ligne (utilisé au lot 2). */
export type SyncState = 'pending' | 'synced'

interface Syncable {
  /** Horodatage de dernière modification, arbitre les conflits de synchro. */
  updatedAt: number
  syncState: SyncState
  /** Suppression logique : jamais de suppression physique, sinon la synchro ressuscite la ligne. */
  deletedAt?: number
  /**
   * Compte propriétaire de la ligne (`auth.uid()` côté serveur).
   *
   * Un gestionnaire reçoit les vacations de toute l'équipe dans sa base locale :
   * sans ce champ, les journées des autres se mélangeraient aux siennes et
   * fausseraient son propre suivi. Absent tant qu'aucun compte n'est connecté —
   * l'application reste utilisable seule, sans synchro.
   */
  ownerId?: string
}

/** Une vacation. */
export interface Workday extends Syncable {
  id: string
  /** Clé de regroupement AAAA-MM-JJ en heure locale. */
  date: string
  /**
   * Redondant avec `endedAt`, mais IndexedDB n'indexe pas les valeurs
   * `undefined` : sans ce champ, retrouver la vacation en cours au démarrage
   * imposerait de parcourir tout l'historique.
   * Invariant : `status === 'open'` ⟺ `endedAt === undefined`.
   */
  status: 'open' | 'closed'
  startedAt: number
  endedAt?: number
  /** Instant à partir duquel le temps est compté en heures supplémentaires. */
  overtimeStartedAt?: number
  notes?: string
}

export interface Order extends Syncable {
  id: string
  workdayId: string
  /** Même raison que `Workday.status` : permet de retrouver la commande en cours. */
  status: 'open' | 'done'
  orderType: OrderType
  /** Nombre de colis annoncé au lancement. */
  colisPlanned: number
  /** Nombre de lignes / références à prélever. */
  linesCount: number
  /** Nombre de colis réellement préparés, confirmé en fin de commande. */
  colisActual?: number
  supports: Supports
  /** Une ou deux destinations préparées en parallèle. */
  storeCount?: 1 | 2
  /** Palette qui reçoit les prochains colis et filmages. */
  activePalletId?: string
  startedAt: number
  endedAt?: number
}

/** Une palette physique suivie au sein d'une commande. */
export interface OrderPallet extends Syncable {
  id: string
  workdayId: string
  orderId: string
  /** Numéro affiché, à partir de 1 et stable après synchronisation. */
  number: number
  storeNumber: 1 | 2
  /** Support choisi à la fin de la commande ou lors d'une correction. */
  support?: SupportKind
  /** Bornes temporelles et bornes du compteur, sans dupliquer la timeline. */
  startedAt: number
  endedAt?: number
  startCount: number
  endCount?: number
}

/** Référence à un segment suspendu, à rouvrir à l'identique. */
export interface SuspendedRef {
  type: SegmentType
  orderId?: string
}

export interface Segment extends Syncable {
  id: string
  workdayId: string
  /** Renseigné dès que le segment appartient au déroulement d'une commande. */
  orderId?: string
  /** Palette active lors du chrono ; absent dans l'ancien historique. */
  palletId?: string
  type: SegmentType
  startedAt: number
  /** Absent tant que le segment est en cours. */
  endedAt?: number
  /**
   * Ce qui est suspendu « sous » ce segment, du plus ancien au plus récent.
   * Une pause déclenchée pendant un trajet lui-même déclenché pendant une
   * prépa porte `[picking, travel]` : fermer la pause rouvre le trajet, fermer
   * le trajet rouvre la prépa. Stocker la pile sur le segment lui-même rend la
   * reprise reconstructible sans état séparé à persister — donc increvable
   * face à un crash ou à une fermeture d'app par iOS.
   */
  stack?: SuspendedRef[]
  /** Renseigné quand l'utilisateur corrige l'horodatage a posteriori. */
  editedAt?: number
  note?: string
}

/** Un appui sur le compteur de progression pendant une commande. */
export interface ColisEvent extends Syncable {
  id: string
  workdayId: string
  orderId: string
  /** Palette active lors de l'appui ; absent dans l'ancien historique. */
  palletId?: string
  at: number
  delta: number
}

/** Un produit prévu mais indisponible pendant la préparation d'une commande. */
export interface StockShortage extends Syncable {
  id: string
  workdayId: string
  orderId: string
  /** Heure du signalement, conservée indépendamment des corrections ultérieures. */
  at: number
  quantity: number
  /** Suivi métier : la rupture reste dans l'historique une fois traitée. */
  resolved: boolean
}

export interface IncidentDef {
  /** Correspond à un SegmentType livré, ou à une ancienne clé personnalisée. */
  key: string
  label: string
  emoji: string
}

/**
 * Liste canonique des aléas. Les clés sont embarquées dans l'application afin
 * qu'un segment créé hors ligne sur l'iPhone soit résolu de la même façon sur
 * le PC après synchronisation.
 */
export const STANDARD_INCIDENTS: readonly IncidentDef[] = [
  { key: 'incident_material', label: 'Matériel', emoji: '🔧' },
  { key: 'incident_bug', label: 'Bug application / réseau', emoji: '🐛' },
  { key: 'incident_colleague_blocked', label: 'Bloqué par des collègues', emoji: '🚧' },
  { key: 'incident_wait', label: 'Attente / blocage non classé', emoji: '⏳' },
  { key: 'incident_human', label: 'Attente chef / aide collègue', emoji: '👥' },
  { key: 'incident_discussion', label: 'Discussion', emoji: '💬' },
  { key: 'incident_forklift', label: 'Cariste', emoji: '🚜' },
  { key: 'incident_support_inverted', label: 'Support inversé', emoji: '🔃' },
  { key: 'incident_vmax_invalid', label: 'Support VMAX non valide', emoji: '⛔' },
  { key: 'incident_wrong_support', label: 'Mauvais support choisi', emoji: '↩️' },
  { key: 'incident_support_unavailable', label: 'Support absent ou abîmé', emoji: '🪵' },
  { key: 'incident_zone_blocked', label: 'Allée ou zone bloquée', emoji: '🚫' },
  { key: 'incident_label', label: 'Étiquette absente / illisible', emoji: '🏷️' },
  { key: 'incident_supplies', label: 'Manque de consommables', emoji: '📦' },
  { key: 'incident_restock_wait', label: 'Attente réapprovisionnement', emoji: '📥' },
  { key: 'incident_location_error', label: 'Emplacement erroné ou vide', emoji: '📍' },
  { key: 'incident_product_damaged', label: 'Produit endommagé', emoji: '💥' },
  { key: 'incident_quality_wait', label: 'Attente de contrôle qualité', emoji: '🔎' },
  { key: 'incident_safety_cleanup', label: 'Casse, nettoyage ou danger', emoji: '⚠️' },
  { key: 'incident_drink', label: 'Boire', emoji: '💧' },
  { key: 'incident_other', label: 'Autre aléa', emoji: '❓' },
]

export interface CartMotionSettings {
  enabled: boolean
  /** Énergie RMS relevée pendant les deux étapes de calibration. */
  stationaryEnergy?: number
  movingEnergy?: number
  /** Seuil dérivé des mesures, utilisé par le classificateur local. */
  threshold?: number
}

export interface RecordingSettings {
  /** Module strictement optionnel : aucune permission n'est demandée tant qu'il est désactivé. */
  enabled: boolean
  /** Suppression automatique des médias locaux anciens. */
  retentionDays: number
}

export interface AISettings {
  /** Module volontairement désactivé tant que le modèle n'est pas installé. */
  enabled: boolean
  /** Analyse visuelle locale du flux arrière, sans conserver les images. */
  visionEnabled: boolean
  /** Collecte manuelle distincte pour préparer un futur modèle métier. */
  trainingCollectionEnabled: boolean
}

export type CoachingCause =
  | 'picking_gap'
  | 'travel'
  | 'incident'
  | 'idle'
  | 'setup'
  | 'wrapping'
  | 'docking'
  | 'pallet'
  | 'shortage'
  | 'break'
  | 'density'
  | 'visual_obstruction'

export interface CoachingEvidence {
  code: string
  label: string
  value: number
  unit: 'colis' | 'minutes' | 'seconds' | 'percent' | 'count'
  /** Une preuve vidéo reste une hypothèse, même avec une confiance élevée. */
  confidence: number
}

export interface VisionObservation {
  at: number
  kind: 'person_in_path' | 'congestion' | 'possible_obstruction'
  confidence: number
  /** Aucune image ni donnée biométrique n'est conservée. */
  durationMs: number
}

export interface CoachingAlert extends Syncable {
  id: string
  workdayId: string
  orderId?: string
  at: number
  cause: CoachingCause
  severity: 'medium' | 'high'
  title: string
  explanation: string
  action: string
  evidence: CoachingEvidence[]
  confidence: number
  delayPackages: number
  modelVersion: string
  readAt?: number
  supersededAt?: number
}

export interface Settings {
  id: 'settings'
  /** Objectif de cadence en colis par heure. */
  targetRate: number
  /** Durée théorique des petites pauses, en minutes. */
  shortBreakMinutes: number
  /** Durée théorique de la grande pause, en minutes. */
  longBreakMinutes: number
  shortBreaksPerDay: number
  longBreaksPerDay: number
  /** Seuils d'alerte « chrono oublié », en minutes, par catégorie. */
  stuckThresholds: {
    interruption: number
    order: number
    break: number
  }
  /**
   * Anciennes définitions locales, conservées pour résoudre l'historique.
   * Les nouveaux segments utilisent toujours `STANDARD_INCIDENTS`.
   */
  incidents: IncidentDef[]
  soundAlerts: boolean
  /** Détection hors ligne des déplacements du chariot à partir des capteurs. */
  cartMotion: CartMotionSettings
  /** Captation locale de la vacation, jamais synchronisée. */
  recording: RecordingSettings
  /** Coach local : aucun calcul ne dépend du réseau ni de Supabase. */
  ai: AISettings
  updatedAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  targetRate: 110,
  shortBreakMinutes: 10,
  longBreakMinutes: 30,
  shortBreaksPerDay: 2,
  longBreaksPerDay: 1,
  stuckThresholds: {
    interruption: 20,
    order: 150,
    break: 45,
  },
  incidents: [...STANDARD_INCIDENTS],
  soundAlerts: true,
  cartMotion: { enabled: false },
  recording: { enabled: false, retentionDays: 3 },
  ai: { enabled: false, visionEnabled: true, trainingCollectionEnabled: false },
  updatedAt: 0,
}
