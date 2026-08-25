import { HOUR, MINUTE } from './time'

export const DAILY_PACKAGE_TARGET = 800

/**
 * Le chef divise les 800 colis par 7 h comptées : 7 h 30 de présence moins
 * uniquement la pause obligatoire de 30 minutes. Les deux pauses de 10 min,
 * le briefing et le nettoyage restent donc dans son dénominateur.
 */
export const MANAGER_COUNTED_HOURS = 7
export const MANAGER_TARGET_RATE = DAILY_PACKAGE_TARGET / MANAGER_COUNTED_HOURS

/** 5 h 50 réellement disponibles pour terminer les commandes avant 20 h. */
export const PRODUCTIVE_MINUTES = 350
export const OPERATIONAL_TARGET_RATE = DAILY_PACKAGE_TARGET / (PRODUCTIVE_MINUTES / 60)

interface MinuteWindow {
  start: number
  end: number
}

export interface ProductionCheckpoint {
  at: number
  target: number
  label: string
}

export interface DailyProductionStatus {
  date: string
  friday: boolean
  actual: number
  target: number
  expected: number
  delta: number
  requiredRate?: number
  managerTargetRate: number
  operationalTargetRate: number
  startAt: number
  ordersDueAt: number
  endAt: number
  checkpoints: ProductionCheckpoint[]
  nextCheckpoint?: ProductionCheckpoint
}

/** Timestamp local : les horaires d'entrepôt ne doivent jamais passer en UTC. */
function localTime(date: string, minuteOfDay: number): number {
  const [year, month, day] = date.split('-').map(Number)
  const hours = Math.floor(minuteOfDay / 60)
  const minutes = minuteOfDay % 60
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

function fridayFor(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 12, 0, 0, 0).getDay() === 5
}

function minutesInside(now: number, window: { start: number; end: number }): number {
  return Math.max(0, Math.min(now, window.end) - window.start) / MINUTE
}

function remainingMinutes(now: number, windows: Array<{ start: number; end: number }>): number {
  return windows.reduce(
    (sum, window) => sum + Math.max(0, window.end - Math.max(now, window.start)) / MINUTE,
    0,
  )
}

/**
 * Planning opérationnel automatique.
 *
 * Lundi–jeudi : 13 h → 20 h 30, commandes terminées à 20 h.
 * Vendredi : tout est avancé de 30 min, donc 12 h 30 → 20 h et commandes
 * terminées à 19 h 30.
 *
 * La cible cumulée avance uniquement pendant les périodes où des colis peuvent
 * réellement être préparés. Elle reste figée pendant briefing et pauses.
 */
export function dailyProductionStatus(
  date: string,
  actual: number,
  now: number = Date.now(),
): DailyProductionStatus {
  const normalizedActual = Math.max(0, actual)
  const friday = fridayFor(date)
  const shift = friday ? -30 : 0
  const at = (minuteOfDay: number) => localTime(date, minuteOfDay + shift)

  const minuteWindows: MinuteWindow[] = [
    { start: 13 * 60 + 20, end: 15 * 60 },
    { start: 15 * 60 + 10, end: 17 * 60 },
    { start: 17 * 60 + 30, end: 19 * 60 },
    { start: 19 * 60 + 10, end: 20 * 60 },
  ]
  const windows = minuteWindows.map((window) => ({
    start: at(window.start),
    end: at(window.end),
  }))

  const productiveElapsed = windows.reduce((sum, window) => sum + minutesInside(now, window), 0)
  const expected = Math.min(
    DAILY_PACKAGE_TARGET,
    (productiveElapsed / PRODUCTIVE_MINUTES) * DAILY_PACKAGE_TARGET,
  )

  const checkpoints: ProductionCheckpoint[] = [
    {
      at: at(15 * 60),
      target: Math.round((100 / PRODUCTIVE_MINUTES) * DAILY_PACKAGE_TARGET),
      label: '1re pause',
    },
    {
      at: at(17 * 60),
      target: Math.round((210 / PRODUCTIVE_MINUTES) * DAILY_PACKAGE_TARGET),
      label: 'grande pause',
    },
    {
      at: at(19 * 60),
      target: Math.round((300 / PRODUCTIVE_MINUTES) * DAILY_PACKAGE_TARGET),
      label: 'dernière pause',
    },
    { at: at(20 * 60), target: DAILY_PACKAGE_TARGET, label: 'fin des commandes' },
  ]
  const nextCheckpoint = checkpoints.find((checkpoint) => now <= checkpoint.at)
  const remainingPackages = Math.max(0, DAILY_PACKAGE_TARGET - normalizedActual)
  const productiveRemaining = remainingMinutes(now, windows)
  const requiredRate = productiveRemaining > 0
    ? remainingPackages / (productiveRemaining / 60)
    : remainingPackages === 0
      ? 0
      : undefined

  return {
    date,
    friday,
    actual: normalizedActual,
    target: DAILY_PACKAGE_TARGET,
    expected,
    delta: normalizedActual - expected,
    requiredRate,
    managerTargetRate: MANAGER_TARGET_RATE,
    operationalTargetRate: OPERATIONAL_TARGET_RATE,
    startAt: at(13 * 60),
    ordersDueAt: at(20 * 60),
    endAt: at(20 * 60 + 30),
    checkpoints,
    nextCheckpoint,
  }
}

/** Temps compté par le chef entre début et fin de vacation, hors pause 30. */
export function managerCountedDuration(presence: number, mandatoryBreak: number): number {
  return Math.max(0, presence - mandatoryBreak)
}

/** Exportée pour garder les calculs de tests et d'interface dans la même unité. */
export const MANAGER_COUNTED_DURATION = MANAGER_COUNTED_HOURS * HOUR
