export function isFalseEnv(value: string | undefined): boolean {
  return ['0', 'false', 'off', 'no'].includes((value ?? '').trim().toLowerCase())
}

export function isTrueEnv(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes((value ?? '').trim().toLowerCase())
}
