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
  startedAt: number
  endedAt?: number
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
  at: number
  delta: number
}

export interface IncidentDef {
  /** Correspond à un SegmentType pour les trois types livrés, libre ensuite. */
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
  { key: 'incident_bug', label: 'Bug', emoji: '🐛' },
  { key: 'incident_discussion', label: 'Discussion', emoji: '💬' },
  { key: 'incident_forklift', label: 'Cariste', emoji: '🚜' },
  { key: 'incident_drink', label: 'Boire', emoji: '💧' },
]

export interface CartMotionSettings {
  enabled: boolean
  /** Énergie RMS relevée pendant les deux étapes de calibration. */
  stationaryEnergy?: number
  movingEnergy?: number
  /** Seuil dérivé des mesures, utilisé par le classificateur local. */
  threshold?: number
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
  updatedAt: 0,
}
