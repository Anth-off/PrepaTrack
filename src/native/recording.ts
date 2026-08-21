import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface FinishedEvent {
  saved: boolean
  error?: string
  interrupted?: boolean
  willResume?: boolean
  retained?: boolean
  startedAt?: number
  recovered?: boolean
  continuing?: boolean
}

interface ResumedEvent { startedAt: number; rotated?: boolean }
interface ResumeFailedEvent { error?: string; retrying?: boolean }

export interface NativeCaptureProfile {
  camera: string
  cameraLayout?: 'frontFullBackPiP' | 'separateFrontBack'
  width: number
  height: number
  framesPerSecond: number
  fieldOfView: number
  backFieldOfView?: number
  backDeviceType?: string
  backLens?: 'ultraWide' | 'wide'
  rearDisplayZoom?: number
  zoomFactor: number
  requestedStabilization: string
  activeStabilization: string
  backRequestedStabilization?: string
  backActiveStabilization?: string
  hardwareCost?: number
  systemPressureCost?: number
  timestampOverlay?: boolean
  timestampOverlayDurationSeconds?: number
  preferredMicrophoneMode?: string
  activeMicrophoneMode?: string
  audioChannels?: number
  voiceProcessingEnabled?: boolean
  audioSessionCategory?: string
  audioSessionMode?: string
  audioInputRoute?: string
  captureConfirmed?: boolean
  audioCaptureConfirmed?: boolean
  framePairsWritten?: number
  audioBuffersWritten?: number
  lastFrameWrittenAt?: number
  frontFileBytes?: number
  rearFileBytes?: number
}

interface NativeRecordingState {
  recording: boolean
  capturing?: boolean
  suspended?: boolean
  startedAt?: number
  captureProfile?: NativeCaptureProfile
}

export interface NativeRecordingRecoveryResult {
  pending: number
  recovered: number
  retained: number
  error?: string
}

interface NativeRecordingPlugin {
  start(options: { maxDurationSeconds: number }): Promise<{ startedAt: number; captureProfile?: NativeCaptureProfile }>
  stop(): Promise<{ saved: boolean }>
  status(): Promise<NativeRecordingState>
  test(): Promise<{ captureProfile?: NativeCaptureProfile }>
  recover(): Promise<NativeRecordingRecoveryResult>
  showMicrophoneModes(): Promise<void>
  addListener(eventName: 'recordingFinished', listener: (event: FinishedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'recordingSegmentFinished', listener: (event: FinishedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'recordingResumed', listener: (event: ResumedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'recordingResumeFailed', listener: (event: ResumeFailedEvent) => void): Promise<PluginListenerHandle>
}

const plugin = registerPlugin<NativeRecordingPlugin>('NativeRecording')
export const nativeRecordingSupported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
export const startNativeRecording = () => plugin.start({ maxDurationSeconds: 1_800 })
export const stopNativeRecording = () => plugin.stop()
export const nativeRecordingStatus = () => plugin.status()
export const testNativeRecording = () => plugin.test()
export const recoverNativeRecordings = () => plugin.recover()
export const showNativeMicrophoneModes = () => plugin.showMicrophoneModes()
export const onNativeRecordingFinished = (listener: (event: FinishedEvent) => void) =>
  plugin.addListener('recordingFinished', listener)
export const onNativeRecordingSegmentFinished = (listener: (event: FinishedEvent) => void) =>
  plugin.addListener('recordingSegmentFinished', listener)
export const onNativeRecordingResumed = (listener: (event: ResumedEvent) => void) =>
  plugin.addListener('recordingResumed', listener)
export const onNativeRecordingResumeFailed = (listener: (event: ResumeFailedEvent) => void) =>
  plugin.addListener('recordingResumeFailed', listener)
