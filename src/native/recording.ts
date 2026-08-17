import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface FinishedEvent {
  saved: boolean
  error?: string
  interrupted?: boolean
  willResume?: boolean
}

interface ResumedEvent { startedAt: number }
interface ResumeFailedEvent { error?: string }

export interface NativeCaptureProfile {
  camera: string
  width: number
  height: number
  framesPerSecond: number
  fieldOfView: number
  zoomFactor: number
  requestedStabilization: string
  activeStabilization: string
  preferredMicrophoneMode?: string
  activeMicrophoneMode?: string
  audioChannels?: number
}

interface NativeRecordingState {
  recording: boolean
  startedAt?: number
  captureProfile?: NativeCaptureProfile
}

interface NativeRecordingPlugin {
  start(options: { maxDurationSeconds: number }): Promise<{ startedAt: number; captureProfile?: NativeCaptureProfile }>
  stop(): Promise<{ saved: boolean }>
  status(): Promise<NativeRecordingState>
  test(): Promise<{ captureProfile?: NativeCaptureProfile }>
  showMicrophoneModes(): Promise<void>
  addListener(eventName: 'recordingFinished', listener: (event: FinishedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'recordingResumed', listener: (event: ResumedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'recordingResumeFailed', listener: (event: ResumeFailedEvent) => void): Promise<PluginListenerHandle>
}

const plugin = registerPlugin<NativeRecordingPlugin>('NativeRecording')
export const nativeRecordingSupported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
export const startNativeRecording = () => plugin.start({ maxDurationSeconds: 3_600 })
export const stopNativeRecording = () => plugin.stop()
export const nativeRecordingStatus = () => plugin.status()
export const testNativeRecording = () => plugin.test()
export const showNativeMicrophoneModes = () => plugin.showMicrophoneModes()
export const onNativeRecordingFinished = (listener: (event: FinishedEvent) => void) =>
  plugin.addListener('recordingFinished', listener)
export const onNativeRecordingResumed = (listener: (event: ResumedEvent) => void) =>
  plugin.addListener('recordingResumed', listener)
export const onNativeRecordingResumeFailed = (listener: (event: ResumeFailedEvent) => void) =>
  plugin.addListener('recordingResumeFailed', listener)
