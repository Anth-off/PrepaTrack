import { useEffect, useState } from 'react'
import { BigButton } from '../components/BigButton'
import { Sheet } from '../components/Sheet'
import { INCIDENT_TYPES, segmentDef } from '../core/segments'
import { formatShort, fromLocalInput, toLocalInput } from '../core/time'
import type { Segment, SegmentType } from '../core/types'
import { deleteSegment, editSegmentBounds, retypeSegment, setSegmentNote } from '../db/repo'

interface Props {
  segment?: Segment
  onClose: () => void
}

const RETYPE_CHOICES: SegmentType[] = [
  'picking',
  'order_setup',
  'wrapping',
  'docking',
  'travel',
  'toilet',
  'pallet_change',
  ...INCIDENT_TYPES,
  'break_10',
  'break_30',
  'idle',
]

/**
 * Correction a posteriori. Indispensable dès le premier jour : un clic oublié
 * en pleine prépa fausserait sinon toutes les cadences de la journée. Les
 * bornes des segments voisins suivent automatiquement, la timeline reste donc
 * continue quoi qu'on corrige.
 */
export function CorrectSheet({ segment, onClose }: Props) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [note, setNote] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!segment) return
    setStart(toLocalInput(segment.startedAt))
    setEnd(segment.endedAt ? toLocalInput(segment.endedAt) : '')
    setNote(segment.note ?? '')
    setConfirmDelete(false)
  }, [segment])

  if (!segment) return null
  const def = segmentDef(segment.type)

  async function save() {
    if (!segment) return
    const bounds: { startedAt?: number; endedAt?: number } = {}
    const nextStart = fromLocalInput(start)
    if (!Number.isNaN(nextStart) && nextStart !== segment.startedAt) {
      bounds.startedAt = nextStart
    }
    if (end) {
      const nextEnd = fromLocalInput(end)
      if (!Number.isNaN(nextEnd) && nextEnd !== segment.endedAt) bounds.endedAt = nextEnd
    }
    if (bounds.startedAt !== undefined || bounds.endedAt !== undefined) {
      await editSegmentBounds(segment.id, bounds)
    }
    if (note !== (segment.note ?? '')) await setSegmentNote(segment.id, note)
    onClose()
  }

  return (
    <Sheet open title={`Corriger — ${def.label}`} onClose={onClose}>
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <p className="text-sm text-slate-400">
          Durée actuelle :{' '}
          <span className="font-bold text-slate-200">
            {formatShort((segment.endedAt ?? Date.now()) - segment.startedAt)}
          </span>
          . Modifier une borne décale automatiquement le segment voisin, pour qu'il ne
          reste ni trou ni chevauchement.
        </p>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-400">Début</span>
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="rounded-xl border border-ink-600 bg-ink-800 px-3 py-3 text-lg"
          />
        </label>

        {segment.endedAt !== undefined && (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-slate-400">Fin</span>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-xl border border-ink-600 bg-ink-800 px-3 py-3 text-lg"
            />
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-400">Note</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="ex : batterie du transpalette à plat"
            className="rounded-xl border border-ink-600 bg-ink-800 px-3 py-3"
          />
        </label>

        <div>
          <div className="mb-2 text-sm font-semibold text-slate-400">
            Mauvais bouton ? Changer le type
          </div>
          <div className="grid grid-cols-3 gap-2">
            {RETYPE_CHOICES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => retypeSegment(segment.id, type)}
                className={`pressable rounded-xl px-2 py-3 text-xs font-bold ${
                  segment.type === type ? 'bg-info text-black' : 'bg-ink-700 text-slate-300'
                }`}
              >
                {segmentDef(type).emoji} {segmentDef(type).short}
              </button>
            ))}
          </div>
        </div>

        <BigButton label="Enregistrer" onClick={save} />

        {confirmDelete ? (
          <BigButton
            label="Confirmer la suppression"
            sub="Le segment précédent absorbera la durée"
            tone="bad"
            onClick={async () => {
              await deleteSegment(segment.id)
              onClose()
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="pressable rounded-xl py-3 text-sm font-semibold text-bad"
          >
            Supprimer ce segment
          </button>
        )}
      </div>
    </Sheet>
  )
}
