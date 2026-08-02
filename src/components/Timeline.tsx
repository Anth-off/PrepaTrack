import { segmentDef } from '../core/segments'
import { segmentDuration } from '../core/metrics'
import { formatShort, hhmm } from '../core/time'
import type { Segment } from '../core/types'

interface Props {
  segments: Segment[]
  now: number
  onSelect?: (segment: Segment) => void
}

/**
 * Le tracé complet de la journée, du premier au dernier geste. Chaque ligne est
 * cliquable pour corriger un horodatage : c'est le filet de sécurité des oublis
 * de clic en pleine prépa.
 */
export function Timeline({ segments, now, onSelect }: Props) {
  if (segments.length === 0) return null

  return (
    <ol className="flex flex-col">
      {segments.map((seg) => {
        const def = segmentDef(seg.type)
        const duration = segmentDuration(seg, now)
        const open = seg.endedAt === undefined
        const Row = onSelect ? 'button' : 'div'

        return (
          <li key={seg.id} className="flex gap-3">
            <div className="flex flex-col items-center pt-1">
              <span className={`h-3 w-3 shrink-0 rounded-full ${def.color}`} />
              <span className="w-px flex-1 bg-ink-600" />
            </div>

            <Row
              {...(onSelect ? { type: 'button' as const, onClick: () => onSelect(seg) } : {})}
              className={`flex-1 pb-4 text-left ${onSelect ? 'pressable' : ''}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">
                  {def.emoji} {def.label}
                </span>
                <span className="tabular shrink-0 text-sm font-bold">
                  {formatShort(duration)}
                  {open && <span className="ml-1 text-accent">•</span>}
                </span>
              </div>
              <div className="tabular text-sm text-slate-500">
                {hhmm(seg.startedAt)} → {seg.endedAt ? hhmm(seg.endedAt) : 'en cours'}
                {seg.editedAt && <span className="ml-2 text-info">corrigé</span>}
              </div>
              {seg.note && <div className="mt-1 text-sm text-slate-400">{seg.note}</div>}
            </Row>
          </li>
        )
      })}
    </ol>
  )
}
