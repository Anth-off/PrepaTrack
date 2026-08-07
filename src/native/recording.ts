import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface FinishedEvent {
  saved: boolean
  error?: string
  interrupted?: boolean
  willResume?: boolean
}

interface ResumedEvent { startedAt: number }
interface ResumeFailedEvent { error?: string }

interface NativeRecordingPlugin {
  start(options: { maxDurationSeconds: number }): Promise<{ startedAt: number }>
  stop(): Promise<{ saved: boolean }>
  status(): Promise<{ recording: boolean; startedAt?: number }>
  test(): Promise<void>
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
export const onNativeRecordingFinished = (listener: (event: FinishedEvent) => void) =>
  plugin.addListener('recordingFinished', listener)
export const onNativeRecordingResumed = (listener: (event: ResumedEvent) => void) =>
  plugin.addListener('recordingResumed', listener)
export const onNativeRecordingResumeFailed = (listener: (event: ResumeFailedEvent) => void) =>
  plugin.addListener('recordingResumeFailed', listener)
