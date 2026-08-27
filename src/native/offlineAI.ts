import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { CoachingDiagnosis } from '../core/coaching'
import type { VisionObservation } from '../core/types'

export interface OfflineAIStatus {
  available: boolean
  ready: boolean
  version: string
  bytes: number
  thermal?: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown'
  visionEnabled?: boolean
  visionBusy?: boolean
  samplingSeconds?: number
}

export interface OfflineAIResult {
  title: string
  explanation: string
  action: string
  modelVersion: string
  latencyMs: number
}

interface OfflineAIPlugin {
  status(): Promise<OfflineAIStatus>
  downloadModel(): Promise<{ ready: boolean }>
  deleteModel(): Promise<{ ready: boolean }>
  analyze(options: { diagnosis: CoachingDiagnosis }): Promise<OfflineAIResult>
  setVisionEnabled(options: { enabled: boolean }): Promise<void>
  captureTrainingSample(options: { label: string }): Promise<{ filename: string }>
  exportTrainingDataset(): Promise<void>
  addListener(
    event: 'modelDownloadProgress',
    listener: (event: { downloaded: number; total: number }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'visionObservation',
    listener: (event: VisionObservation) => void,
  ): Promise<PluginListenerHandle>
}

const plugin = registerPlugin<OfflineAIPlugin>('OfflineAI')
const supported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

export const offlineAI = {
  supported,
  async status(): Promise<OfflineAIStatus> {
    return supported()
      ? plugin.status()
      : { available: false, ready: false, version: '', bytes: 0 }
  },
  downloadModel: () => plugin.downloadModel(),
  deleteModel: () => plugin.deleteModel(),
  analyze: (diagnosis: CoachingDiagnosis) => plugin.analyze({ diagnosis }),
  setVisionEnabled: (enabled: boolean) => supported()
    ? plugin.setVisionEnabled({ enabled })
    : Promise.resolve(),
  captureTrainingSample: (label: string) => plugin.captureTrainingSample({ label }),
  exportTrainingDataset: () => plugin.exportTrainingDataset(),
  onDownloadProgress: (listener: (event: { downloaded: number; total: number }) => void) =>
    plugin.addListener('modelDownloadProgress', listener),
  onVisionObservation: (listener: (event: VisionObservation) => void) =>
    plugin.addListener('visionObservation', listener),
}
