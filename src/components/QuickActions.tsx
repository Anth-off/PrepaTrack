import { useState } from 'react'
import { canInterrupt, type MachineView } from '../core/machine'
import { BREAK_TYPES, segmentDef } from '../core/segments'
import type { SegmentType, Settings } from '../core/types'

interface Props {
  view: MachineView
  settings: Settings
  breaksTaken: Record<string, number>
  onTrigger: (type: SegmentType) => void
}

/**
 * Barre d'actions permanente, en bas de l'écran (zone du pouce). Chaque bouton
 * est un basculement : un appui ouvre l'interruption, un second la ferme.
 * L'interruption en cours est mise en évidence, ce qui rend l'état lisible
 * d'un coup d'œil sans lire de texte.
 */
export function QuickActions({ view, settings, breaksTaken, onTrigger }: Props) {
  const [menu, setMenu] = useState<'incident' | 'break' | null>(null)
  const activeType = view.active?.type

  function trigger(type: SegmentType) {
    setMenu(null)
    onTrigger(type)
  }

  const cell = (
    key: string,
    emoji: string,
    label: string,
    onClick: () => void,
    opts: { active?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      disabled={opts.disabled}
      className={`pressable flex min-h-[4rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 disabled:opacity-25 ${
        opts.active ? 'bg-accent text-black' : 'bg-ink-700 text-slate-200'
      }`}
    >
      <span className="text-2xl leading-none">{emoji}</span>
      <span className="text-[0.65rem] font-bold uppercase tracking-wide">{label}</span>
    </button>
  )

  const incidentActive = settings.incidents.some((i) => i.key === activeType)
  const breakActive = BREAK_TYPES.includes(activeType as SegmentType)

  return (
    <div className="relative">
      {menu === 'incident' && (
        <MenuPanel onClose={() => setMenu(null)}>
          {settings.incidents.map((incident) =>
            cell(
              incident.key,
              incident.emoji,
              incident.label,
              () => trigger(incident.key as SegmentType),
              { active: activeType === incident.key },
            ),
          )}
        </MenuPanel>
      )}

      {menu === 'break' && (
        <MenuPanel onClose={() => setMenu(null)}>
          {BREAK_TYPES.map((type) => {
            const taken = breaksTaken[type] ?? 0
            const quota =
              type === 'break_10' ? settings.shortBreaksPerDay : settings.longBreaksPerDay
            return cell(
              type,
              segmentDef(type).emoji,
              `${segmentDef(type).short} ${taken}/${quota}`,
              () => trigger(type),
              { active: activeType === type },
            )
          })}
        </MenuPanel>
      )}

      {/* Pas de `safe-bottom` ici : la barre d'onglets se trouve juste en
          dessous et gère déjà la zone réservée du téléphone. */}
      <div className="flex shrink-0 gap-2 border-t border-ink-600 bg-ink-800 px-2 py-2">
        {cell('travel', segmentDef('travel').emoji, 'Trajet', () => trigger('travel'), {
          active: activeType === 'travel',
          disabled: !canInterrupt(view, 'travel'),
        })}
        {cell('toilet', segmentDef('toilet').emoji, 'WC', () => trigger('toilet'), {
          active: activeType === 'toilet',
          disabled: !canInterrupt(view, 'toilet'),
        })}
        {cell(
          'pallet',
          segmentDef('pallet_change').emoji,
          'Palette',
          () => trigger('pallet_change'),
          {
            active: activeType === 'pallet_change',
            disabled: !canInterrupt(view, 'pallet_change'),
          },
        )}
        {cell(
          'incident',
          '⚠️',
          'Aléa',
          () => setMenu(menu === 'incident' ? null : 'incident'),
          { active: incidentActive, disabled: view.phase === 'no_day' },
        )}
        {cell('break', '☕', 'Pause', () => setMenu(menu === 'break' ? null : 'break'), {
          active: breakActive,
          disabled: view.phase === 'no_day',
        })}
      </div>
    </div>
  )
}

function MenuPanel({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute bottom-full left-0 right-0 z-20 mb-1 flex gap-2 rounded-2xl border border-ink-600 bg-ink-800 p-2 shadow-2xl">
        {children}
      </div>
    </>
  )
}
