/** Utilitaires de temps. Aucune durée n'est jamais accumulée en mémoire :
 *  tout est recalculé à partir d'horodatages absolus, pour que l'app reste
 *  exacte après un verrouillage d'écran, une mise en veille ou un crash. */

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE

/** Clé de journée locale AAAA-MM-JJ (pas d'UTC : la vacation est locale). */
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** « 14:07 » */
export function hhmm(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** « 14:07:33 » */
export function hhmmss(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Durée en chrono : « 1:04:12 » au-delà d'une heure, « 4:12 » sinon. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

/** Durée compacte pour les tableaux et bilans : « 1h04 », « 12 min », « 45 s ». */
export function formatShort(ms: number): string {
  const total = Math.max(0, Math.round(ms / SECOND))
  if (total < 60) return `${total} s`
  const m = Math.round(total / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}`
}

/** Convertit une durée en nombre d'heures décimales. */
export function toHours(ms: number): number {
  return ms / HOUR
}

/** Date lisible : « mardi 30 juillet ». */
export function formatDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

/** Valeur d'un `<input type="datetime-local">` à partir d'un timestamp. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Timestamp à partir d'une valeur de `<input type="datetime-local">`. */
export function fromLocalInput(value: string): number {
  return new Date(value).getTime()
}
