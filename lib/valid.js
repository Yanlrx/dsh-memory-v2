export function isValid(record, now = new Date()) {
  const kinds = Array.isArray(record?.kind) ? record.kind : []
  const hasState = kinds.includes('状态')
  const hasPreference = kinds.includes('偏好')

  if (!hasState && !hasPreference) return true
  if (hasPreference && record.ttl == null && !hasState) return true

  const confirmedAt = new Date(record.last_confirmed).getTime()
  const currentAt = new Date(now).getTime()
  const match = typeof record.ttl === 'string'
    ? record.ttl.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|mo|y)$/)
    : null

  if (!Number.isFinite(confirmedAt) || !Number.isFinite(currentAt) || !match) return false

  const amount = Number(match[1])
  const unit = match[2]
  const milliseconds = unit === 'ms' ? amount
    : unit === 's' ? amount * 1000
      : unit === 'm' ? amount * 60 * 1000
        : unit === 'h' ? amount * 60 * 60 * 1000
          : unit === 'd' ? amount * 24 * 60 * 60 * 1000
            : unit === 'w' ? amount * 7 * 24 * 60 * 60 * 1000
              : unit === 'mo' ? amount * 30 * 24 * 60 * 60 * 1000
                : amount * 365 * 24 * 60 * 60 * 1000

  return currentAt - confirmedAt < milliseconds
}
