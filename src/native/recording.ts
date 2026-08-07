import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface FinishedEvent { saved: boolean; error?: string }

interface NativeRecordingPlugin {
  start(options: { maxDurationSeconds: number }): Promise<{ startedAt: number }>
  stop(): Promise<{ saved: boolean }>
  status(): Promise<{ recording: boolean; startedAt?: number }>
  test(): Promise<void>
  addListener(eventName: 'recordingFinished', listener: (event: FinishedEvent) => void): Promise<PluginListenerHandle>
}

const plugin = registerPlugin<NativeRecordingPlugin>('NativeRecording')
export const nativeRecordingSupported = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
export const startNativeRecording = () => plugin.start({ maxDurationSeconds: 3_600 })
export const stopNativeRecording = () => plugin.stop()
export const nativeRecordingStatus = () => plugin.status()
export const testNativeRecording = () => plugin.test()
export const onNativeRecordingFinished = (listener: (event: FinishedEvent) => void) =>
  plugin.addListener('recordingFinished', listener)
