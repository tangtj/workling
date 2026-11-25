export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function sumRange(start: number, end: number): number {
  const min = Math.min(start, end)
  const max = Math.max(start, end)
  return ((max - min + 1) * (min + max)) / 2
}
