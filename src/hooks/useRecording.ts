import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RECORDING_BITS_PER_SECOND,
  RECORDING_CHUNK_MS,
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

export type RecordingStatus = 'disabled' | 'idle' | 'requesting' | 'recording' | 'stopping' | 'interrupted' | 'error'

export interface RecordingControl {
  status: RecordingStatus
  startedAt?: number
  message?: string
  supported: boolean
  start: () => Promise<void>
  stop: (reason?: RecordingEndReason) => Promise<void>
  testDevices: () => Promise<boolean>
}

const CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  video: {
    facingMode: { ideal: 'user' },
    width: { ideal: 640, max: 640 },
    height: { ideal: 360, max: 360 },
    frameRate: { ideal: 15, max: 20 },
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
  const supported = recordingSupported()
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
      videoBitsPerSecond: 320_000,
      audioBitsPerSecond: 40_000,
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
          setStatus('error')
          setMessage('La vidéo n’a pas pu être enregistrée localement. Les chronos sont conservés.')
        }
      }
      if (continueRef.current && dayRef.current === dayId && stream.active) {
        startChunkRef.current(stream, dayId)
      } else {
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
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      setStatus('stopping')
      recorder.stop()
    } else {
      releaseStream()
      setStartedAt(undefined)
      setStatus(enabled ? (reason === 'interrupted' ? 'interrupted' : 'idle') : 'disabled')
    }
  }, [enabled, releaseStream])

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
  }, [enabled, retentionDays, startChunk, status, stop, supported, workdayId, releaseStream])

  const testDevices = useCallback(async () => {
    if (!supported) {
      setMessage('L’enregistrement caméra/micro n’est pas pris en charge sur cet appareil.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
      stream.getTracks().forEach((track) => track.stop())
      setMessage('Caméra avant et microphone disponibles.')
      return true
    } catch (error) {
      setMessage(mediaErrorMessage(error))
      return false
    }
  }, [supported])

  useEffect(() => {
    if (!enabled) void stop('complete')
    else if (status === 'disabled') setStatus('idle')
  }, [enabled, status, stop])

  useEffect(() => {
    if (!workdayId && ['recording', 'requesting'].includes(status)) void stop('complete')
  }, [status, stop, workdayId])

  useEffect(() => {
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
  }, [stop])

  return { status, startedAt, message, supported, start, stop, testDevices }
}

export const RECORDING_ESTIMATED_BITS_PER_SECOND = RECORDING_BITS_PER_SECOND
