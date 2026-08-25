import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RECORDING_AUDIO_BITS_PER_SECOND,
  RECORDING_BITS_PER_SECOND,
  RECORDING_CHUNK_MS,
  RECORDING_VIDEO_BITS_PER_SECOND,
  mediaErrorMessage,
  recordingRecoveryMessage,
  recordingStorageWarning,
  recordingSupported,
  selectRecordingMime,
} from '../core/recording'
import {
  nextRecordingSequence,
  purgeExpiredRecordings,
  saveRecordingChunk,
  type RecordingEndReason,
} from '../db/recordings'
import {
  nativeRecordingSupported,
  nativeRecordingStatus,
  onNativeRecordingFinished,
  onNativeRecordingSegmentFinished,
  onNativeRecordingResumed,
  onNativeRecordingResumeFailed,
  recoverNativeRecordings,
  startNativeRecording,
  stopNativeRecording,
  showNativeMicrophoneModes,
  testNativeRecording,
  type NativeCaptureProfile,
} from '../native/recording'

export type RecordingStatus = 'disabled' | 'idle' | 'requesting' | 'recording' | 'stopping' | 'interrupted' | 'error'

export interface RecordingControl {
  status: RecordingStatus
  startedAt?: number
  message?: string
  supported: boolean
  canStart: boolean
  recovering: boolean
  recoveryMessage?: string
  start: () => Promise<void>
  stop: (reason?: RecordingEndReason) => Promise<void>
  testDevices: () => Promise<boolean>
  recoverVideos: () => Promise<void>
  showMicrophoneModes: () => Promise<void>
}

const CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  video: {
    facingMode: { ideal: 'user' },
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 24, max: 30 },
  },
}

const stabilizationLabel = (mode: string) => ({
  cinematicExtendedEnhanced: 'cinématique renforcée',
  cinematicExtended: 'cinématique étendue',
  cinematic: 'cinématique',
  standard: 'standard',
  auto: 'automatique',
  off: 'inactive',
}[mode] ?? mode)

const microphoneModeLabel = (mode?: string) => ({
  automatic: 'automatique',
  standard: 'standard',
  voiceIsolation: 'isolement de la voix',
  wideSpectrum: 'large spectre',
}[mode ?? ''] ?? mode)

const captureProfileMessage = (profile: NativeCaptureProfile, recording = false) => {
  const mode = recording && profile.activeStabilization !== 'off'
    ? profile.activeStabilization
    : profile.requestedStabilization
  const state = recording && profile.activeStabilization === 'off'
    ? ' demandée (confirmation iOS en cours)'
    : ''
  const microphone = profile.activeMicrophoneMode
    ? `, micro ${microphoneModeLabel(profile.activeMicrophoneMode)} (${profile.audioChannels ?? 1} ${profile.audioChannels === 1 ? 'canal' : 'canaux'}, traitement vocal ${profile.voiceProcessingEnabled ? 'actif' : 'inactif'})`
    : ''
  const cameras = profile.cameraLayout === 'separateFrontBack'
    ? `caméras avant + arrière (deux vidéos séparées${profile.timestampOverlay ? `, angle/date/heure pendant les ${profile.timestampOverlayDurationSeconds ?? 3} premières secondes` : ''})`
    : profile.cameraLayout === 'frontFullBackPiP'
      ? `caméras avant + arrière (avant principale, arrière incrustée${profile.timestampOverlay ? ', date/heure incrustées' : ''})`
      : 'caméra avant'
  const rearMode = recording && profile.backActiveStabilization
    ? profile.backActiveStabilization
    : profile.backRequestedStabilization
  const rearLens = profile.rearDisplayZoom
    ? `, arrière ${String(profile.rearDisplayZoom).replace('.', ',')}×${profile.backFieldOfView ? ` (${Math.round(profile.backFieldOfView)}°)` : ''}`
    : profile.backFieldOfView
      ? `, champ arrière ${Math.round(profile.backFieldOfView)}°`
      : ''
  const rear = rearMode
    ? `${rearLens}, stabilisation arrière ${stabilizationLabel(rearMode)}`
    : ''
  const durableCapture = recording
    ? profile.captureConfirmed && profile.audioCaptureConfirmed
      ? ', écriture AVANT + ARRIÈRE + micro confirmée sur le stockage local'
      : ', confirmation d’écriture locale en cours'
    : ''
  return `Profil ${cameras} : ${profile.width}×${profile.height} à ${profile.framesPerSecond} i/s, champ avant ${Math.round(profile.fieldOfView)}°, stabilisation avant ${stabilizationLabel(mode)}${state}${rear}${microphone}${durableCapture}.`
}

export const RECORDING_INTENT_STORAGE_KEY = 'prepatrack.recording.intent.v1'
export const RECORDING_INTENT_RETRY_DELAYS_MS = [0, 5_000, 30_000] as const

export interface PersistentRecordingIntent {
  version: 1
  workdayId: string
  requestedAt: number
}

type RecordingIntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const recordingIntentStorage = (): RecordingIntentStorage | undefined => {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function parsePersistentRecordingIntent(value: string | null): PersistentRecordingIntent | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<PersistentRecordingIntent>
    if (parsed.version !== 1 || typeof parsed.workdayId !== 'string' || parsed.workdayId.length === 0) {
      return undefined
    }
    if (typeof parsed.requestedAt !== 'number' || !Number.isFinite(parsed.requestedAt)) return undefined
    return parsed as PersistentRecordingIntent
  } catch {
    return undefined
  }
}

export function readPersistentRecordingIntent(
  storage: RecordingIntentStorage | undefined = recordingIntentStorage(),
): PersistentRecordingIntent | undefined {
  if (!storage) return undefined
  try {
    return parsePersistentRecordingIntent(storage.getItem(RECORDING_INTENT_STORAGE_KEY))
  } catch {
    return undefined
  }
}

export function rememberPersistentRecordingIntent(
  workdayId: string,
  storage: RecordingIntentStorage | undefined = recordingIntentStorage(),
  now = Date.now(),
): boolean {
  if (!storage || !workdayId) return false
  try {
    storage.setItem(RECORDING_INTENT_STORAGE_KEY, JSON.stringify({ version: 1, workdayId, requestedAt: now }))
    return true
  } catch {
    // Une captation ne doit jamais être interrompue parce que localStorage est
    // momentanément indisponible. Le natif reste alors l'unique source d'état.
    return false
  }
}

export function clearPersistentRecordingIntent(
  storage: RecordingIntentStorage | undefined = recordingIntentStorage(),
): void {
  if (!storage) return
  try {
    storage.removeItem(RECORDING_INTENT_STORAGE_KEY)
  } catch {
    // Une erreur de stockage ne doit pas masquer l'arrêt volontaire natif.
  }
}

export function shouldResumePersistentRecording(
  intent: PersistentRecordingIntent | undefined,
  workdayId: string | undefined,
  enabled: boolean,
): boolean {
  return Boolean(enabled && workdayId && intent?.workdayId === workdayId)
}

export function shouldClearPersistentRecordingIntent(
  previous: { enabled: boolean; workdayId: string | undefined },
  current: { enabled: boolean; workdayId: string | undefined },
): boolean {
  const moduleWasDisabled = previous.enabled && !current.enabled
  const dayEnded = Boolean(previous.workdayId && !current.workdayId)
  // Quand IndexedDB finit de charger une journée avec le module désactivé,
  // le false initial devient un choix confirmé et non plus une valeur d'attente.
  const disabledSettingWasLoaded = Boolean(!previous.workdayId && current.workdayId && !current.enabled)
  return moduleWasDisabled || dayEnded || disabledSettingWasLoaded
}

/**
 * Contrôleur global de captation. Aucun aperçu n'est conservé et aucune
 * permission n'est demandée avant une action explicite de l'utilisateur.
 */
export function useRecording(
  workdayId: string | undefined,
  enabled: boolean,
  retentionDays: number,
): RecordingControl {
  const native = nativeRecordingSupported()
  const supported = native || recordingSupported()
  const [status, setStatus] = useState<RecordingStatus>(enabled ? 'idle' : 'disabled')
  const [startedAt, setStartedAt] = useState<number>()
  const [message, setMessage] = useState<string>()
  const [recovering, setRecovering] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState<string>()
  const [intentResumeTrigger, setIntentResumeTrigger] = useState(0)
  const streamRef = useRef<MediaStream>()
  const recorderRef = useRef<MediaRecorder>()
  const timerRef = useRef<number>()
  const continueRef = useRef(false)
  const reasonRef = useRef<RecordingEndReason>('complete')
  const dayRef = useRef(workdayId)
  const sequenceRef = useRef(1)
  const requestRef = useRef(0)
  const startInFlightRef = useRef(false)
  const recoveryRequestRef = useRef(false)
  const startChunkRef = useRef<(stream: MediaStream, dayId: string) => void>(() => undefined)
  const startRecordingRef = useRef<() => Promise<void>>(async () => undefined)
  const intentResumeAttemptRef = useRef({ workdayId: '', attempts: 0 })
  const lifecycleRef = useRef({ enabled, workdayId })

  useEffect(() => {
    dayRef.current = workdayId
  }, [workdayId])

  const releaseStream = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = undefined
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = undefined
  }, [])

  const startChunk = useCallback((stream: MediaStream, dayId: string) => {
    const mimeType = selectRecordingMime((mime) => MediaRecorder.isTypeSupported(mime))
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: RECORDING_VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
    })
    const parts: Blob[] = []
    const chunkStartedAt = Date.now()
    recorderRef.current = recorder
    setStartedAt(chunkStartedAt)
    setStatus('recording')

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data)
    }
    recorder.onerror = () => {
      continueRef.current = false
      reasonRef.current = 'interrupted'
      setStatus('error')
      setMessage('Une erreur média a interrompu l’enregistrement. La journée continue normalement.')
    }
    recorder.onstop = async () => {
      const endedAt = Date.now()
      const blob = new Blob(parts, { type: recorder.mimeType || mimeType || 'video/webm' })
      const rotate = continueRef.current && dayRef.current === dayId && stream.active
      const endReason = reasonRef.current
      // Démarre le fichier suivant avant l'écriture du précédent dans
      // IndexedDB. Sur iPhone, attendre cette écriture créait un raccord noir.
      if (rotate) startChunkRef.current(stream, dayId)
      if (blob.size > 0) {
        try {
          await saveRecordingChunk({
            workdayId: dayId,
            sequence: sequenceRef.current++,
            startedAt: chunkStartedAt,
            endedAt,
            duration: endedAt - chunkStartedAt,
            size: blob.size,
            mimeType: blob.type,
            status: endReason,
            blob,
          })
        } catch {
          continueRef.current = false
          const current = recorderRef.current
          if (current && current !== recorder && current.state !== 'inactive') current.stop()
          setStatus('error')
          setMessage('La vidéo n’a pas pu être enregistrée localement. Les chronos sont conservés.')
        }
      }
      if (!rotate) {
        releaseStream()
        setStartedAt(undefined)
        setStatus(enabled ? (reasonRef.current === 'interrupted' ? 'interrupted' : 'idle') : 'disabled')
      }
    }
    recorder.start(30_000)
    timerRef.current = window.setTimeout(() => {
      reasonRef.current = 'complete'
      if (recorder.state !== 'inactive') recorder.stop()
    }, RECORDING_CHUNK_MS)
  }, [enabled, releaseStream])

  useEffect(() => {
    startChunkRef.current = startChunk
  }, [startChunk])

  const stop = useCallback(async (reason: RecordingEndReason = 'complete') => {
    if (reason === 'complete') {
      clearPersistentRecordingIntent()
      intentResumeAttemptRef.current = { workdayId: '', attempts: 0 }
    }
    requestRef.current += 1
    continueRef.current = false
    reasonRef.current = reason
    if (timerRef.current) window.clearTimeout(timerRef.current)
    if (native) {
      setStatus('stopping')
      try {
        const result = await stopNativeRecording()
        setStartedAt(undefined)
        setStatus(enabled ? (reason === 'interrupted' ? 'interrupted' : 'idle') : 'disabled')
        if (result.saved) setMessage('Vidéos avant et arrière enregistrées dans Photos.')
      } catch (error) {
        setStatus('error')
        setMessage(mediaErrorMessage(error))
      }
      return
    }
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      setStatus('stopping')
      recorder.stop()
    } else {
      releaseStream()
      setStartedAt(undefined)
      setStatus(enabled ? (reason === 'interrupted' ? 'interrupted' : 'idle') : 'disabled')
    }
  }, [enabled, native, releaseStream])

  const start = useCallback(async () => {
    if (startInFlightRef.current || !enabled || !workdayId || recovering || status === 'recording' || status === 'requesting') return
    startInFlightRef.current = true
    setMessage(undefined)
    setRecoveryMessage(undefined)
    if (!supported) {
      setStatus('error')
      setMessage('L’enregistrement caméra/micro n’est pas pris en charge sur cet appareil.')
      return
    }
    setStatus('requesting')
    const request = ++requestRef.current
    let createdPendingIntent = false
    try {
      if (native) {
        const existingIntent = readPersistentRecordingIntent()
        if (!shouldResumePersistentRecording(existingIntent, workdayId, enabled)) {
          // Écrire l'intention avant l'appel natif ferme la fenêtre où iOS
          // pourrait tuer l'app pendant les quelques secondes de validation
          // AVANT + ARRIÈRE + micro.
          rememberPersistentRecordingIntent(workdayId)
          createdPendingIntent = true
        }
        const result = await startNativeRecording()
        if (request !== requestRef.current || !enabled || dayRef.current !== workdayId) {
          await stopNativeRecording()
          return
        }
        rememberPersistentRecordingIntent(workdayId)
        intentResumeAttemptRef.current = { workdayId, attempts: 0 }
        setStartedAt(result.startedAt)
        setStatus('recording')
        if (result.captureProfile) setMessage(captureProfileMessage(result.captureProfile, true))
        window.setTimeout(() => {
          void nativeRecordingStatus().then((value) => {
            if (value.recording && value.captureProfile) {
              setMessage(captureProfileMessage(value.captureProfile, true))
            }
          })
        }, 1_000)
        return
      }
      await purgeExpiredRecordings(retentionDays)
      const estimate = await navigator.storage?.estimate?.()
      const warning = recordingStorageWarning(estimate)
      if (warning?.startsWith('Espace insuffisant')) throw new Error(warning)
      if (warning) setMessage(warning)
      const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
      if (request !== requestRef.current || !enabled || dayRef.current !== workdayId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      continueRef.current = true
      reasonRef.current = 'complete'
      sequenceRef.current = await nextRecordingSequence(workdayId)
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => void stop('interrupted'), { once: true })
      }
      startChunk(stream, workdayId)
    } catch (error) {
      if (createdPendingIntent) clearPersistentRecordingIntent()
      releaseStream()
      setStatus('error')
      setMessage(mediaErrorMessage(error))
    } finally {
      startInFlightRef.current = false
    }
  }, [enabled, native, recovering, retentionDays, startChunk, status, stop, supported, workdayId, releaseStream])

  useEffect(() => {
    startRecordingRef.current = start
  }, [start])

  const testDevices = useCallback(async () => {
    if (!supported) {
      setMessage('L’enregistrement caméra/micro n’est pas pris en charge sur cet appareil.')
      return false
    }
    try {
      if (native) {
        const result = await testNativeRecording()
        setMessage(result.captureProfile
          ? `Test réel réussi : fichiers AVANT, ARRIÈRE et micro écrits puis relus. ${captureProfileMessage(result.captureProfile)}`
          : 'Test réel réussi : fichiers AVANT, ARRIÈRE et micro écrits puis relus.')
        return true
      }
      const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
      stream.getTracks().forEach((track) => track.stop())
      setMessage('Caméra avant et microphone disponibles.')
      return true
    } catch (error) {
      setMessage(mediaErrorMessage(error))
      return false
    }
  }, [native, supported])

  const showMicrophoneModes = useCallback(async () => {
    if (!native) {
      setMessage('Le sélecteur de modes micro est disponible uniquement dans l’app iPhone.')
      return
    }
    try {
      await showNativeMicrophoneModes()
      setMessage('Choisis Automatique, Standard, Isolement de la voix ou Large spectre dans le panneau iOS.')
    } catch (error) {
      setMessage(mediaErrorMessage(error))
    }
  }, [native])

  const recoverVideos = useCallback(async () => {
    if (recoveryRequestRef.current || ['recording', 'requesting', 'stopping'].includes(status)) return
    if (!native) {
      setRecoveryMessage('La récupération des vidéos locales est disponible uniquement dans l’app iPhone.')
      return
    }
    recoveryRequestRef.current = true
    setRecovering(true)
    setRecoveryMessage('Recherche des vidéos conservées localement…')
    try {
      const result = await recoverNativeRecordings()
      setRecoveryMessage(recordingRecoveryMessage(result))
    } catch (error) {
      const detail = error instanceof Error && error.message
        ? error.message
        : 'le stockage vidéo local est momentanément indisponible.'
      setRecoveryMessage(`Récupération impossible : ${detail}`)
    } finally {
      recoveryRequestRef.current = false
      setRecovering(false)
    }
  }, [native, status])

  useEffect(() => {
    if (!native) return
    let cancelled = false
    let finishedHandle: Awaited<ReturnType<typeof onNativeRecordingFinished>> | undefined
    let segmentHandle: Awaited<ReturnType<typeof onNativeRecordingSegmentFinished>> | undefined
    let resumedHandle: Awaited<ReturnType<typeof onNativeRecordingResumed>> | undefined
    let failedHandle: Awaited<ReturnType<typeof onNativeRecordingResumeFailed>> | undefined
    void onNativeRecordingFinished((event) => {
      setStartedAt(undefined)
      if (event.willResume) {
        setStatus(enabled ? 'requesting' : 'disabled')
        setMessage(event.saved
          ? 'Vidéo sauvegardée. Reprise automatique au déverrouillage…'
          : 'Vidéo conservée localement. Reprise automatique au déverrouillage…')
      } else if (event.saved) {
        setStatus(enabled ? 'idle' : 'disabled')
        setMessage('Vidéos avant et arrière enregistrées dans Photos.')
      } else {
        setStatus('error')
        setMessage(event.error ?? 'La vidéo n’a pas pu être ajoutée à Photos.')
      }
    }).then((listener) => {
      if (cancelled) void listener.remove()
      else finishedHandle = listener
    })
    void onNativeRecordingSegmentFinished((event) => {
      const time = event.startedAt
        ? new Date(event.startedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : undefined
      if (event.recovered) {
        setMessage(event.saved
          ? `Vidéo${time ? ` de ${time}` : ''} récupérée et ajoutée à Photos.`
          : `Vidéo${time ? ` de ${time}` : ''} conservée localement : la récupération sera retentée.`)
        if (enabled && shouldResumePersistentRecording(
          readPersistentRecordingIntent(),
          dayRef.current,
          enabled,
        )) {
          intentResumeAttemptRef.current = { workdayId: dayRef.current ?? '', attempts: 0 }
          setIntentResumeTrigger((trigger) => trigger + 1)
        }
        return
      }
      if (event.interrupted && event.willResume) {
        setStatus('requesting')
        setMessage(event.saved
          ? 'Segment ajouté à Photos. Reprise automatique en attente…'
          : 'Segment conservé localement. Reprise automatique en attente…')
        return
      }
      const continuation = event.continuing === false ? '' : ' L’enregistrement continue.'
      setMessage(event.saved
        ? `Vidéos avant/arrière${time ? ` de ${time}` : ''} enregistrées dans Photos.${continuation}`
        : `Segment${time ? ` de ${time}` : ''} conservé localement pour récupération.${continuation}`)
    }).then((listener) => {
      if (cancelled) void listener.remove()
      else segmentHandle = listener
    })
    void onNativeRecordingResumed((event) => {
      if (enabled && dayRef.current) {
        rememberPersistentRecordingIntent(dayRef.current)
        intentResumeAttemptRef.current = { workdayId: dayRef.current, attempts: 0 }
      }
      setStartedAt(event.startedAt)
      setStatus('recording')
      setMessage(event.rotated
        ? 'Nouveau fichier de 30 minutes démarré automatiquement.'
        : 'Enregistrement repris automatiquement après le déverrouillage.')
    }).then((listener) => {
      if (cancelled) void listener.remove()
      else resumedHandle = listener
    })
    void onNativeRecordingResumeFailed((event) => {
      setStartedAt(undefined)
      setStatus(event.retrying ? 'requesting' : 'error')
      setMessage(event.retrying
        ? `Reprise temporairement impossible${event.error ? ` : ${event.error}` : ''}. Nouvelle tentative automatique…`
        : (event.error ?? 'La caméra n’a pas pu reprendre après le déverrouillage.'))
    }).then((listener) => {
      if (cancelled) void listener.remove()
      else failedHandle = listener
    })
    return () => {
      cancelled = true
      void finishedHandle?.remove()
      void segmentHandle?.remove()
      void resumedHandle?.remove()
      void failedHandle?.remove()
    }
  }, [enabled, native])

  useEffect(() => {
    const previous = lifecycleRef.current
    const current = { enabled, workdayId }
    lifecycleRef.current = current
    // Au premier rendu, les réglages et la journée sont encore en cours de
    // lecture dans IndexedDB (enabled=false/workdayId=undefined par défaut).
    // On ne coupe donc rien avant que l'identifiant de journée soit connu.
    if (shouldClearPersistentRecordingIntent(previous, current)) {
      clearPersistentRecordingIntent()
      intentResumeAttemptRef.current = { workdayId: '', attempts: 0 }
      void stop('complete')
      return
    }
    if (!enabled) {
      if (status !== 'disabled') setStatus('disabled')
      return
    }
    if (status === 'disabled') setStatus('idle')
  }, [enabled, status, stop, workdayId])

  useEffect(() => {
    if (!native || !enabled || !workdayId || recovering) return
    const intent = readPersistentRecordingIntent()
    if (intent && intent.workdayId !== workdayId) {
      // Une intention appartient à une seule vacation. Elle ne doit jamais
      // démarrer la caméra pour la journée suivante. Ne pas la supprimer ici :
      // l'identifiant courant peut avoir changé automatiquement après une
      // restauration ou une synchro, sans arrêt volontaire de l'utilisateur.
      intentResumeAttemptRef.current = { workdayId: '', attempts: 0 }
      return
    }
    if (!shouldResumePersistentRecording(intent, workdayId, enabled)) {
      intentResumeAttemptRef.current = { workdayId: '', attempts: 0 }
      return
    }
    if (status === 'recording') {
      intentResumeAttemptRef.current = { workdayId, attempts: 0 }
      return
    }
    if (['disabled', 'requesting', 'stopping'].includes(status)) return
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return

    if (intentResumeAttemptRef.current.workdayId !== workdayId) {
      intentResumeAttemptRef.current = { workdayId, attempts: 0 }
    }
    const attempt = intentResumeAttemptRef.current.attempts
    if (attempt >= RECORDING_INTENT_RETRY_DELAYS_MS.length) {
      setMessage('La reprise automatique reste en attente. Nouvelle vérification dans une minute, sans toucher aux vidéos déjà conservées.')
      const retryTimer = window.setTimeout(() => {
        intentResumeAttemptRef.current = { workdayId, attempts: 0 }
        setIntentResumeTrigger((value) => value + 1)
      }, 60_000)
      return () => window.clearTimeout(retryTimer)
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled) return
      const currentIntent = readPersistentRecordingIntent()
      if (!shouldResumePersistentRecording(currentIntent, dayRef.current, enabled)) return
      intentResumeAttemptRef.current.attempts += 1
      void nativeRecordingStatus()
        .then((value) => {
          if (cancelled) return
          if (value.capturing) {
            rememberPersistentRecordingIntent(workdayId)
            intentResumeAttemptRef.current = { workdayId, attempts: 0 }
            setStartedAt(value.startedAt)
            setStatus('recording')
            return
          }
          if (value.recording && value.suspended) {
            setStartedAt(undefined)
            setStatus('requesting')
            setMessage('Reprise automatique de l’enregistrement en attente…')
            return
          }
          return startRecordingRef.current()
        })
        .catch(() => {
          if (!cancelled) setIntentResumeTrigger((value) => value + 1)
        })
    }, RECORDING_INTENT_RETRY_DELAYS_MS[attempt])
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled, intentResumeTrigger, native, recovering, status, workdayId])

  useEffect(() => {
    if (native) {
      const reconcile = () => {
        if (document.visibilityState !== 'visible') return
        void nativeRecordingStatus().then((value) => {
          if (value.capturing) {
            if (enabled && dayRef.current) {
              rememberPersistentRecordingIntent(dayRef.current)
              intentResumeAttemptRef.current = { workdayId: dayRef.current, attempts: 0 }
            }
            setStartedAt(value.startedAt)
            setStatus('recording')
          } else if (value.recording && value.suspended) {
            setStartedAt(undefined)
            setStatus('requesting')
            setMessage('Reprise automatique de l’enregistrement en attente…')
          } else {
            setStartedAt(undefined)
            setStatus(enabled ? 'idle' : 'disabled')
            setIntentResumeTrigger((trigger) => trigger + 1)
          }
        }).catch(() => setIntentResumeTrigger((trigger) => trigger + 1))
      }
      reconcile()
      document.addEventListener('visibilitychange', reconcile)
      return () => document.removeEventListener('visibilitychange', reconcile)
    }
    const interrupt = () => void stop('interrupted')
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') interrupt()
    }
    window.addEventListener('pagehide', interrupt)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', interrupt)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, native, stop])

  return {
    status,
    startedAt,
    message,
    supported,
    canStart: Boolean(workdayId),
    recovering,
    recoveryMessage,
    start,
    stop,
    testDevices,
    recoverVideos,
    showMicrophoneModes,
  }
}

export const RECORDING_ESTIMATED_BITS_PER_SECOND = RECORDING_BITS_PER_SECOND
