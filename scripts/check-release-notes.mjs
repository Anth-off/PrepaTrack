import { pathToFileURL } from 'node:url'

const VISIBLE_TYPES = new Set(['feat', 'fix', 'perf', 'refactor', 'docs'])
const PLACEHOLDER = 'chore: aucune note utilisateur pour cette maintenance interne'
const BEGIN = 'BEGIN_COMMIT_OVERRIDE'
const END = 'END_COMMIT_OVERRIDE'
const HEADER = /^(feat|fix|perf|refactor|docs)(?:\([^)\r\n]+\))?(!)?: (.+)$/u

export function validateReleaseNotes(title, body) {
  const titleMatch = title.match(/^(feat|fix|perf|refactor|docs)(?:\([^)\r\n]+\))?(!)?: /u)
  if (!titleMatch || !VISIBLE_TYPES.has(titleMatch[1])) return []

  const errors = []
  const beginCount = occurrences(body, BEGIN)
  const endCount = occurrences(body, END)

  if (beginCount !== 1 || endCount !== 1) {
    return [
      `La PR doit contenir exactement un bloc ${BEGIN} … ${END} dans « Notes de version ».`,
    ]
  }

  const beginAt = body.indexOf(BEGIN) + BEGIN.length
  const endAt = body.indexOf(END)
  if (endAt <= beginAt) return [`Le marqueur ${END} doit être placé après ${BEGIN}.`]

  const block = body.slice(beginAt, endAt).trim()
  if (!block || block === PLACEHOLDER) {
    return [
      'Remplace la note générique par au moins une phrase décrivant le changement pour l’utilisateur.',
    ]
  }

  const entries = block.split(/\r?\n\s*\r?\n/u).filter(Boolean)
  for (const [index, entry] of entries.entries()) {
    if (/\r?\n/u.test(entry)) {
      errors.push(`Entrée ${index + 1} : utilise une seule ligne par changement visible.`)
      continue
    }

    const match = entry.match(HEADER)
    if (!match) {
      errors.push(
        `Entrée ${index + 1} : format attendu, par exemple « fix(mobile): supprimer l’espace vide sur iPhone ».`
      )
      continue
    }

    const [, type, breaking, subject] = match
    if (index === 0 && (type !== titleMatch[1] || Boolean(breaking) !== Boolean(titleMatch[2]))) {
      errors.push(
        `Entrée 1 : conserve le type${titleMatch[2] ? ' et le « ! »' : ''} du titre (${titleMatch[1]}${titleMatch[2] ?? ''}:).`,
      )
    }
    if (subject.length < 20) {
      errors.push(`Entrée ${index + 1} : précise davantage l’effet visible (20 caractères minimum).`)
    }
    if (/^\p{Lu}/u.test(subject)) {
      errors.push(`Entrée ${index + 1} : la description doit commencer par une minuscule.`)
    }
  }

  return errors
}

function occurrences(value, searched) {
  return value.split(searched).length - 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateReleaseNotes(process.env.PR_TITLE ?? '', process.env.PR_BODY ?? '')
  if (errors.length > 0) {
    console.error('Notes de version invalides :')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log('Notes de version valides.')
  }
}
