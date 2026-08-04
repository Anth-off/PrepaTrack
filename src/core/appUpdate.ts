export type UpdateNoticeMode = 'hidden' | 'deferred' | 'actionable'

export interface UpdatePolicyInput {
  updateReady: boolean
  workdayActive: boolean
  online: boolean
}

export interface UpdatePolicy {
  notice: UpdateNoticeMode
  activationAllowed: boolean
  /** La version déjà installée reste la solution de repli, réseau ou non. */
  currentVersionUsable: true
}

/**
 * Décision pure séparée du service worker : aucune condition réseau ne doit
 * transformer une mise à jour en interruption de la vacation.
 */
export function appUpdatePolicy({
  updateReady,
  workdayActive,
}: UpdatePolicyInput): UpdatePolicy {
  if (!updateReady) {
    return { notice: 'hidden', activationAllowed: false, currentVersionUsable: true }
  }

  if (workdayActive) {
    return { notice: 'deferred', activationAllowed: false, currentVersionUsable: true }
  }

  return { notice: 'actionable', activationAllowed: true, currentVersionUsable: true }
}
