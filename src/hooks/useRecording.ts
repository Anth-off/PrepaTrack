import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RECORDING_AUDIO_BITS_PER_SECOND,
  RECORDING_BITS_PER_SECOND,
  RECORDING_CHUNK_MS,
  RECORDING_VIDEO_BITS_PER_SECOND,
  mediaErrorMessage,
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
  start: () => Promise<void>
  stop: (reason?: RecordingEndReason) => Promise<void>
  testDevices: () => Promise<boolean>
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
    ? `caméras avant + arrière (deux vidéos séparées${profile.timestampOverlay ? ', angle/date/heure incrustés' : ''})`
    : profile.cameraLayout === 'frontFullBackPiP'
      ? `caméras avant + arrière (avant principale, arrière incrustée${profile.timestampOverlay ? ', date/heure incrustées' : ''})`
      : 'caméra avant'
  const rear = profile.backActiveStabilization
    ? `, arrière ${stabilizationLabel(profile.backActiveStabilization)}`
    : ''
  return `Profil ${cameras} : ${profile.width}×${profile.height} à ${profile.framesPerSecond} i/s, champ avant ${Math.round(profile.fieldOfView)}°, stabilisation avant ${stabilizationLabel(mode)}${state}${rear}${microphone}.`
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
  const streamRef = useRef<MediaStream>()
  const recorderRef = useRef<MediaRecorder>()
  const timerRef = useRef<number>()
  const continueRef = useRef(false)
  const reasonRef = useRef<RecordingEndReason>('complete')
  const dayRef = useRef(workdayId)
  const sequenceRef = useRef(1)
  const requestRef = useRef(0)
  const startChunkRef = useRef<(stream: MediaStream, dayId: string) => void>(() => undefined)

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
    if (!enabled || !workdayId || status === 'recording' || status === 'requesting') return
    setMessage(undefined)
    if (!supported) {
      setStatus('error')
      setMessage('L’enregistrement caméra/micro n’est pas pris en charge sur cet appareil.')
      return
    }
    setStatus('requesting')
    const request = ++requestRef.current
    try {
      if (native) {
        const result = await startNativeRecording()
        if (request !== requestRef.current || !enabled || dayRef.current !== workdayId) {
          await stopNativeRecording()
          return
        }
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
      releaseStream()
      setStatus('error')
      setMessage(mediaErrorMessage(error))
    }
  }, [enabled, native, retentionDays, startChunk, status, stop, supported, workdayId, releaseStream])

  const testDevices = useCallback(async () => {
    if (!supported) {
      setMessage('L’enregistrement caméra/micro n’est pas pris en charge sur cet appareil.')
      return false
    }
    try {
      if (native) {
        const result = await testNativeRecording()
        setMessage(result.captureProfile
          ? `Caméras avant/arrière, microphone et Photos disponibles. ${captureProfileMessage(result.captureProfile)}`
          : 'Caméras avant/arrière, microphone et Photos disponibles.')
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

  useEffect(() => {
    if (!native) return
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
    }).then((listener) => { finishedHandle = listener })
    void onNativeRecordingSegmentFinished((event) => {
      const time = event.startedAt
        ? new Date(event.startedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : undefined
      if (event.recovered) {
        setMessage(event.saved
          ? `Vidéo${time ? ` de ${time}` : ''} récupérée et ajoutée à Photos.`
          : `Vidéo${time ? ` de ${time}` : ''} conservée localement : la récupération sera retentée.`)
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
    }).then((listener) => { segmentHandle = listener })
    void onNativeRecordingResumed((event) => {
      setStartedAt(event.startedAt)
      setStatus('recording')
      setMessage(event.rotated
        ? 'Nouveau fichier de 30 minutes démarré automatiquement.'
        : 'Enregistrement repris automatiquement après le déverrouillage.')
    }).then((listener) => { resumedHandle = listener })
    void onNativeRecordingResumeFailed((event) => {
      setStartedAt(undefined)
      setStatus(event.retrying ? 'requesting' : 'error')
      setMessage(event.retrying
        ? `Reprise temporairement impossible${event.error ? ` : ${event.error}` : ''}. Nouvelle tentative automatique…`
        : (event.error ?? 'La caméra n’a pas pu reprendre après le déverrouillage.'))
    }).then((listener) => { failedHandle = listener })
    return () => {
      void finishedHandle?.remove()
      void segmentHandle?.remove()
      void resumedHandle?.remove()
      void failedHandle?.remove()
    }
  }, [enabled, native])

  useEffect(() => {
    if (!enabled) void stop('complete')
    else if (status === 'disabled') setStatus('idle')
  }, [enabled, status, stop])

  useEffect(() => {
    if (!workdayId && ['recording', 'requesting'].includes(status)) void stop('complete')
  }, [status, stop, workdayId])

  useEffect(() => {
    if (native) {
      const reconcile = () => {
        if (document.visibilityState !== 'visible') return
        void nativeRecordingStatus().then((value) => {
          if (value.capturing) {
            setStartedAt(value.startedAt)
            setStatus('recording')
          } else if (value.recording && value.suspended) {
            setStartedAt(undefined)
            setStatus('requesting')
            setMessage('Reprise automatique de l’enregistrement en attente…')
          } else {
            setStartedAt(undefined)
            setStatus(enabled ? 'idle' : 'disabled')
          }
        })
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

  return { status, startedAt, message, supported, canStart: Boolean(workdayId), start, stop, testDevices, showMicrophoneModes }
}

export const RECORDING_ESTIMATED_BITS_PER_SECOND = RECORDING_BITS_PER_SECOND
