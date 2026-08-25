import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { CartMotionSample } from '../core/cartMotion'

interface NativeCartMotionSample {
  at: number
  x: number
  y: number
  z: number
}

interface CartMotionPlugin {
  start(): Promise<void>
  stop(): Promise<void>
  addListener(
    eventName: 'sample',
    listener: (sample: NativeCartMotionSample) => void,
  ): Promise<PluginListenerHandle>
}

const plugin = registerPlugin<CartMotionPlugin>('CartMotion')

export function nativeCartMotionSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
}

export function toCartMotionSample(sample: NativeCartMotionSample): CartMotionSample {
  return {
    at: sample.at,
    acceleration: { x: sample.x, y: sample.y, z: sample.z },
  }
}

/** Démarre Core Motion et renvoie un arrêt idempotent. */
export async function startNativeCartMotion(
  onSample: (sample: CartMotionSample) => void,
): Promise<() => Promise<void>> {
  const handle = await plugin.addListener('sample', (sample) => {
    onSample(toCartMotionSample(sample))
  })
  try {
    await plugin.start()
  } catch (cause) {
    await handle.remove()
    throw cause
  }
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    await handle.remove()
    await plugin.stop()
  }
}
