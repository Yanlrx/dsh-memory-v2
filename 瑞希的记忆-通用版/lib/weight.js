export function getWeight(record, now = new Date()) {
  const recalled = Math.max(0, Number(record?.被召回次数) || 0)
  if (recalled === 0) return 0

  const currentAt = new Date(now).getTime()
  const referenceAt = new Date(record?.event_time ?? record?.last_confirmed).getTime()
  const age = Number.isFinite(currentAt) && Number.isFinite(referenceAt)
    ? Math.max(0, currentAt - referenceAt)
    : 0
  const frequency = 1 - Math.exp(-recalled)
  const decay = Math.exp(-Math.LN2 * age / (30 * 24 * 60 * 60 * 1000))
  const weight = frequency * decay

  return Math.max(0, Math.min(1, weight))
}
