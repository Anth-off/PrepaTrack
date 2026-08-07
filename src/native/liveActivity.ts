import { Capacitor, registerPlugin } from '@capacitor/core'

export interface LiveActivityState {
  phase: string
  detail: string
  packages: number
  plannedPackages: number
  recording: boolean
  phaseStartedAt: number
}

interface LiveActivityPlugin {
  start(options: LiveActivityState & { workdayId: string; workdayStartedAt: number }): Promise<{ active: boolean }>
  update(options: LiveActivityState): Promise<{ active: boolean }>
  end(): Promise<void>
}

const plugin = registerPlugin<LiveActivityPlugin>('LiveActivity')
const supported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

export async function startLiveActivity(
  options: LiveActivityState & { workdayId: string; workdayStartedAt: number },
): Promise<void> {
  if (supported()) await plugin.start(options)
}

export async function updateLiveActivity(options: LiveActivityState): Promise<void> {
  if (supported()) await plugin.update(options)
}

export async function endLiveActivity(): Promise<void> {
  if (supported()) await plugin.end()
}
