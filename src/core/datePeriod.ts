export type DatePeriod = 7 | 30 | 'all' | 'custom'

export interface DatedItem {
  date: string
}

/** Date locale ISO, sans conversion UTC susceptible de changer le jour. */
function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Filtre inclusif sur les dates métier des vacations.
 *
 * Une plage identique (du 21 au 21) sélectionne donc une seule journée. Les
 * bornes inversées sont normalisées : une manipulation rapide du calendrier ne
 * doit jamais donner un écran vide incompréhensible.
 */
export function filterByDatePeriod<T extends DatedItem>(
  items: T[],
  period: DatePeriod,
  now: number,
  fromDate = '',
  toDate = '',
): T[] {
  if (period === 'all') return items

  if (period === 'custom') {
    const first = fromDate && toDate ? (fromDate <= toDate ? fromDate : toDate) : fromDate || undefined
    const last = fromDate && toDate ? (fromDate <= toDate ? toDate : fromDate) : toDate || undefined
    return items.filter(
      (item) => (first === undefined || item.date >= first) && (last === undefined || item.date <= last),
    )
  }

  const cutoff = new Date(now)
  cutoff.setHours(12, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (period - 1))
  const first = localDate(cutoff.getTime())
  return items.filter((item) => item.date >= first)
}
