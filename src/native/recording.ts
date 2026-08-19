import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { RECORDING_CHUNK_MS } from '../core/recording'

interface FinishedEvent {
  saved: boolean
  continues?: boolean
  recovered?: boolean
  error?: string
  interrupted?: boolean
  willResume?: boolean
}

interface ResumedEvent { startedAt: number }
interface ResumeFailedEvent { error?: string }

interface NativeRecordingPlugin {
  start(options: { maxDurationSeconds: number }): Promise<{ startedAt: number }>
  stop(): Promise<{ saved: boolean; pending?: boolean }>
  status(): Promise<{ recording: boolean; startedAt?: number }>
  test(): Promise<void>
  addListener(eventName: 'recordingFinished', listener: (event: FinishedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'recordingResumed', listener: (event: ResumedEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'recordingResumeFailed', listener: (event: ResumeFailedEvent) => void): Promise<PluginListenerHandle>
}

const plugin = registerPlugin<NativeRecordingPlugin>('NativeRecording')
export const nativeRecordingSupported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
export const startNativeRecording = () =>
  plugin.start({ maxDurationSeconds: RECORDING_CHUNK_MS / 1_000 })
export const stopNativeRecording = () => plugin.stop()
export const nativeRecordingStatus = () => plugin.status()
export const testNativeRecording = () => plugin.test()
export const onNativeRecordingFinished = (listener: (event: FinishedEvent) => void) =>
  plugin.addListener('recordingFinished', listener)
export const onNativeRecordingResumed = (listener: (event: ResumedEvent) => void) =>
  plugin.addListener('recordingResumed', listener)
export const onNativeRecordingResumeFailed = (listener: (event: ResumeFailedEvent) => void) =>
  plugin.addListener('recordingResumeFailed', listener)
