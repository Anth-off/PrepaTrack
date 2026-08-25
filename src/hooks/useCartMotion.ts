import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AutomaticTravelGuard,
  CartMotionDetector,
  MotionEnergyMeter,
  rootMeanSquare,
  type CartMotionSample,
} from '../core/cartMotion'
import type { Session } from './useSession'
import { setAutomaticTravel } from '../db/repo'
import {
  nativeCartMotionSupported,
  startNativeCartMotion,
} from '../native/cartMotion'

export type CartMotionStatus =
  | 'unsupported'
  | 'permission_needed'
  | 'denied'
  | 'ready'
  | 'stationary'
  | 'moving'
  | 'calibrating_stationary'
  | 'calibrating_moving'
  | 'error'

export interface CartMotionControl {
  supported: boolean
  status: CartMotionStatus
  error?: string
  requestPermission: () => Promise<boolean>
  calibrate: (kind: 'stationary' | 'moving') => Promise<number>
}

interface CalibrationRun {
  kind: 'stationary' | 'moving'
  startsAt: number
  values: number[]
  meter: MotionEnergyMeter
  resolve: (score: number) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

type MotionPermissionConstructor = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

const CALIBRATION_WARMUP_MS = 1_500
const CALIBRATION_CAPTURE_MS = 7_000
const MIN_CALIBRATION_SAMPLES = 25

/**
 * Écoute les capteurs en local et applique les transitions à la timeline. Aucun
 * échantillon ne quitte l'appareil ; seules les durées de trajet sont stockées.
 */
export function useCartMotion(session: Session): CartMotionControl {
  const native = nativeCartMotionSupported()
  const webMotionSupported =
    typeof window !== 'undefined' && typeof window.DeviceMotionEvent !== 'undefined'
  const supported = native || webMotionSupported
  const [status, setStatus] = useState<CartMotionStatus>(
    supported ? 'permission_needed' : 'unsupported',
  )
  const [error, setError] = useState<string>()
  const permissionGranted = useRef(false)
  const runtimeMeter = useRef(new MotionEnergyMeter())
  const detector = useRef<CartMotionDetector>()
  const travelGuard = useRef(new AutomaticTravelGuard())
  const calibration = useRef<CalibrationRun>()
  const transitionQueue = useRef(Promise.resolve())
  const samplesReceived = useRef(0)
  const enabled = session.settings.cartMotion.enabled
  const threshold = session.settings.cartMotion.threshold

  useEffect(() => {
    detector.current = threshold === undefined ? undefined : new CartMotionDetector(threshold)
    travelGuard.current = new AutomaticTravelGuard()
    runtimeMeter.current = new MotionEnergyMeter()
  }, [threshold])

  useEffect(() => {
    // `useSession` expose brièvement les valeurs par défaut pendant la lecture
    // d'IndexedDB. Ne surtout pas interpréter ce faux `enabled: false` comme une
    // désactivation demandée à chaque ouverture de l'application.
    if (session.loading || enabled) return
    detector.current = threshold === undefined ? undefined : new CartMotionDetector(threshold)
    transitionQueue.current = transitionQueue.current.then(async () => {
      await setAutomaticTravel(false)
    })
  }, [enabled, session.loading, threshold])

  // Réapplique l'état physique à chaque changement de phase métier. Le chariot
  // est ainsi détecté pendant toute la vacation, y compris briefing, attente,
  // préparation de commande, mise à quai et rangement.
  useEffect(() => {
    if (session.loading || !enabled || threshold === undefined) return
    if (status !== 'moving' && status !== 'stationary') return
    const desiredMoving = travelGuard.current.desiredMoving(
      status,
      session.view.active?.type === 'travel',
    )
    transitionQueue.current = transitionQueue.current
      .then(async () => {
        await setAutomaticTravel(desiredMoving)
      })
      .catch(() => {
        setError("Impossible d'enregistrer automatiquement le trajet.")
        setStatus('error')
      })
  }, [
    enabled,
    session.loading,
    session.view.active?.id,
    session.view.active?.type,
    session.view.phase,
    status,
    threshold,
  ])

  const calibrating =
    status === 'calibrating_stationary' || status === 'calibrating_moving'
  const listening = enabled || calibrating

  useEffect(() => {
    if (!supported || session.loading || !listening) return

    const onSample = (sample: CartMotionSample) => {
      permissionGranted.current = true
      samplesReceived.current += 1
      const run = calibration.current
      if (run) {
        const energy = run.meter.sample(sample)
        if (energy !== undefined && Date.now() >= run.startsAt) run.values.push(energy)
        return
      }

      if (!enabled || threshold === undefined) {
        setStatus('ready')
        return
      }

      const energy = runtimeMeter.current.sample(sample)
      if (energy === undefined) return
      const transition = detector.current?.push(sample.at, energy)
      if (!transition) {
        setStatus(detector.current?.current() ?? 'stationary')
        return
      }

      setStatus(transition)
    }

    if (!native) {
      const onMotion = (event: DeviceMotionEvent) => onSample(fromDeviceMotion(event))
      window.addEventListener('devicemotion', onMotion)
      return () => window.removeEventListener('devicemotion', onMotion)
    }

    let disposed = false
    let stop: (() => Promise<void>) | undefined
    const initialSamples = samplesReceived.current
    const noSampleTimer = window.setTimeout(() => {
      if (disposed || samplesReceived.current > initialSamples) return
      setError("Aucune mesure reçue de l'iPhone. Relance l'écoute des capteurs.")
      setStatus('error')
    }, 5_000)

    void startNativeCartMotion(onSample)
      .then(async (cleanup) => {
        if (disposed) await cleanup()
        else stop = cleanup
      })
      .catch(() => {
        if (disposed) return
        setError("Core Motion n'a pas pu démarrer sur l'iPhone.")
        setStatus('error')
      })

    return () => {
      disposed = true
      window.clearTimeout(noSampleTimer)
      void stop?.()
    }
  }, [enabled, listening, native, session.loading, supported, threshold])

  useEffect(() => {
    if (!enabled || status !== 'moving') return
    const watchdog = window.setInterval(() => {
      // Cette horloge ne dépend pas de `devicemotion` : elle termine aussi un
      // arrêt candidat quand iOS espace les mesures sans les couper totalement.
      if (detector.current?.tick(Date.now()) === 'stationary') setStatus('stationary')
    }, 500)
    return () => window.clearInterval(watchdog)
  }, [enabled, status])

  const requestPermission = useCallback(async () => {
    if (!supported) return false
    // Core Motion natif ne dépend pas de la permission JavaScript de WKWebView.
    // Le premier échantillon confirme ensuite explicitement que l'écoute tourne.
    if (native) {
      permissionGranted.current = true
      setStatus('ready')
      setError(undefined)
      return true
    }
    try {
      const ctor = DeviceMotionEvent as MotionPermissionConstructor
      const result = ctor.requestPermission ? await ctor.requestPermission() : 'granted'
      const granted = result === 'granted'
      permissionGranted.current = granted
      setStatus(granted ? 'ready' : 'denied')
      setError(granted ? undefined : "L'accès aux capteurs a été refusé par iOS.")
      return granted
    } catch {
      setStatus('denied')
      setError("iOS n'a pas autorisé l'accès aux capteurs de mouvement.")
      return false
    }
  }, [native, supported])

  const calibrate = useCallback(
    async (kind: 'stationary' | 'moving') => {
      if (!supported) throw new Error('Capteurs non disponibles sur cet appareil.')
      if (!permissionGranted.current && !(await requestPermission())) {
        throw new Error("Autorise d'abord les capteurs de mouvement.")
      }
      if (calibration.current) throw new Error('Une calibration est déjà en cours.')

      setError(undefined)
      setStatus(kind === 'stationary' ? 'calibrating_stationary' : 'calibrating_moving')
      return new Promise<number>((resolve, reject) => {
        const run: CalibrationRun = {
          kind,
          startsAt: Date.now() + CALIBRATION_WARMUP_MS,
          values: [],
          meter: new MotionEnergyMeter(),
          resolve,
          reject,
        }
        run.timer = setTimeout(() => {
          calibration.current = undefined
          if (run.values.length < MIN_CALIBRATION_SAMPLES) {
            const failure = new Error('Pas assez de mesures reçues. Vérifie les permissions iOS.')
            setError(failure.message)
            setStatus('error')
            run.reject(failure)
            return
          }
          const score = rootMeanSquare(run.values)
          setStatus('ready')
          run.resolve(score)
        }, CALIBRATION_WARMUP_MS + CALIBRATION_CAPTURE_MS)
        calibration.current = run
      })
    },
    [requestPermission, supported],
  )

  useEffect(
    () => () => {
      const run = calibration.current
      if (!run) return
      if (run.timer) clearTimeout(run.timer)
      run.reject(new Error('Calibration interrompue.'))
      calibration.current = undefined
    },
    [],
  )

  return { supported, status, error, requestPermission, calibrate }
}

function fromDeviceMotion(event: DeviceMotionEvent): CartMotionSample {
  return {
    at: Date.now(),
    acceleration: vector(event.acceleration),
    accelerationIncludingGravity: vector(event.accelerationIncludingGravity),
  }
}

function vector(value: DeviceMotionEventAcceleration | null):
  | { x: number; y: number; z: number }
  | undefined {
  if (value?.x == null || value.y == null || value.z == null) return undefined
  return { x: value.x, y: value.y, z: value.z }
}
