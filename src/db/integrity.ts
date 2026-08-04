import type { IntegrityIssue } from '../core/integrity'
import { getMeta, setMeta } from './db'

const META_KEY = 'integrity-dismissals'
export type IntegrityDismissals = Record<string, string>

export async function getIntegrityDismissals(): Promise<IntegrityDismissals> {
  return getMeta<IntegrityDismissals>(META_KEY, {})
}

/** Confirme un faux positif jusqu'à ce que l'une des données concernées change. */
export async function dismissIntegrityIssue(issue: IntegrityIssue): Promise<void> {
  const current = await getIntegrityDismissals()
  await setMeta(META_KEY, { ...current, [issue.id]: issue.fingerprint })
}

export function visibleIntegrityIssues(
  issues: IntegrityIssue[],
  dismissals: IntegrityDismissals,
): IntegrityIssue[] {
  return issues.filter((issue) => dismissals[issue.id] !== issue.fingerprint)
}
