/**
 * Microwave-style timer entry: the cook types digits exactly as the kitchen
 * timer shows them. The last two digits are seconds, the rest minutes —
 * "1022" is 10:22, "130" is 1:30, "45" is 45 seconds.
 */
export function timerDigits(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 5)
}

export function formatTimerDigits(digits: string): string {
  if (digits.length <= 2) return digits
  return `${digits.slice(0, -2)}:${digits.slice(-2)}`
}

export function parseTimerDigits(digits: string): number | null {
  if (!digits) return null
  const seconds = Number(digits.slice(-2))
  const minutes = digits.length > 2 ? Number(digits.slice(0, -2)) : 0
  const total = minutes * 60 + seconds
  return total > 0 ? total : null
}

export function formatSeconds(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds)
  const minutes = Math.floor(rounded / 60)
  const seconds = rounded % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function formatSecondsPerUnit(seconds: number): string {
  const digits = seconds < 10 ? 1 : 0
  return `${seconds.toFixed(digits)} sec/pc`
}
