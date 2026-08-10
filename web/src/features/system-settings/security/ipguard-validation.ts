export const isValidStringArrayJSON = (value: string) => {
  if (!value || value.trim() === '') return true
  try {
    const parsed = JSON.parse(value)
    return (
      Array.isArray(parsed) &&
      parsed.every((el) => typeof el === 'string' && el.length > 0)
    )
  } catch {
    return false
  }
}

export const isValidBanDurationsJSON = (value: string) => {
  if (!value || value.trim() === '') return true
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return false
    for (const key of ['suspect', 'malicious', 'critical']) {
      const val = parsed[key as keyof typeof parsed]
      if (typeof val !== 'number' || val <= 0) return false
    }
    return true
  } catch {
    return false
  }
}

export const isValidHeuristicsJSON = (value: string) => {
  if (!value || value.trim() === '') return true
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}
