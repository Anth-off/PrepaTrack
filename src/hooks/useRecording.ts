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
  onNativeRecordingResumed,
  onNativeRecordingResumeFailed,
  startNativeRecording,
  stopNativeRecording,
  testNativeRecording,
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
            status: reasonRef.current,
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
        if (result.pending) {
          setMessage('Vidéo sécurisée sur l’iPhone. Ajout à Photos en arrière-plan…')
        } else if (result.saved) {
          setMessage('Vidéo enregistrée dans Photos.')
        }
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
        await testNativeRecording()
        setMessage('Caméra avant, microphone et Photos disponibles.')
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

  useEffect(() => {
    if (!native) return
    let finishedHandle: Awaited<ReturnType<typeof onNativeRecordingFinished>> | undefined
    let resumedHandle: Awaited<ReturnType<typeof onNativeRecordingResumed>> | undefined
    let failedHandle: Awaited<ReturnType<typeof onNativeRecordingResumeFailed>> | undefined
    void onNativeRecordingFinished((event) => {
      if (event.recovered) {
        setMessage(event.saved
          ? 'Une vidéo interrompue a été récupérée et ajoutée à Photos.'
          : event.error ?? 'Une vidéo interrompue reste sécurisée sur l’iPhone.')
        return
      }
      if (event.continues) {
        setStatus('recording')
        setMessage(event.saved
          ? 'Extrait sécurisé dans Photos. L’enregistrement continue.'
          : 'L’enregistrement continue ; un extrait reste sécurisé sur l’iPhone.')
        return
      }
      setStartedAt(undefined)
      if (event.willResume) {
        setStatus(enabled ? 'requesting' : 'disabled')
        setMessage(event.saved
          ? 'Vidéo sauvegardée. Reprise automatique au déverrouillage…'
          : 'Vidéo conservée localement. Reprise automatique au déverrouillage…')
      } else if (event.saved) {
        setStatus(enabled ? 'idle' : 'disabled')
        setMessage('Vidéo enregistrée dans Photos.')
      } else {
        setStatus('error')
        setMessage(event.error ?? 'La vidéo n’a pas pu être ajoutée à Photos.')
      }
    }).then((listener) => { finishedHandle = listener })
    void onNativeRecordingResumed((event) => {
      setStartedAt(event.startedAt)
      setStatus('recording')
      setMessage('Enregistrement repris automatiquement après le déverrouillage.')
    }).then((listener) => { resumedHandle = listener })
    void onNativeRecordingResumeFailed((event) => {
      setStartedAt(undefined)
      setStatus('error')
      setMessage(event.error ?? 'La caméra n’a pas pu reprendre après le déverrouillage.')
    }).then((listener) => { failedHandle = listener })
    return () => {
      void finishedHandle?.remove()
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
          if (value.recording) {
            setStartedAt(value.startedAt)
            setStatus('recording')
          } else {
            setStartedAt(undefined)
            setStatus(enabled ? 'idle' : 'disabled')
          }
        })
      }
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

  return { status, startedAt, message, supported, canStart: Boolean(workdayId), start, stop, testDevices }
}

export const RECORDING_ESTIMATED_BITS_PER_SECOND = RECORDING_BITS_PER_SECOND
