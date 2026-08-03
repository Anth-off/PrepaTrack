import type { ReactNode } from 'react'

type Tone = 'accent' | 'ok' | 'bad' | 'neutral' | 'info'

const TONES: Record<Tone, string> = {
  accent: 'bg-accent text-black',
  ok: 'bg-ok text-black',
  bad: 'bg-bad text-white',
  info: 'bg-info text-black',
  neutral: 'bg-ink-700 text-slate-100 border border-ink-600',
}

interface Props {
  label: ReactNode
  sub?: ReactNode
  onClick: () => void
  tone?: Tone
  disabled?: boolean
  compact?: boolean
}

/** Action principale. Pleine largeur et haute : atteignable au pouce, gants compris. */
export function BigButton({
  label,
  sub,
  onClick,
  tone = 'accent',
  disabled,
  compact = false,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`pressable w-full rounded-2xl px-4 font-bold leading-tight shadow-lg disabled:opacity-40 ${
        compact ? 'min-h-[3.25rem] py-2 text-xl' : 'min-h-touch py-4 text-2xl'
      } ${TONES[tone]}`}
    >
      <span className="block">{label}</span>
      {sub && <span className="mt-1 block text-sm font-medium opacity-70">{sub}</span>}
    </button>
  )
}
