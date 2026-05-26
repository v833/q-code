export interface ColorEnvironment {
  NO_COLOR?: string | undefined
  FORCE_COLOR?: string | undefined
}

const NO_COLOR_FLAGS = new Set(['--no-color', '--no-colors', '--color=false', '--color=never'])

export function applyNoColorEnvironment(
  argv: readonly string[] = process.argv,
  env: ColorEnvironment = process.env
): void {
  const hasNoColorFlag = argv.some((arg) => NO_COLOR_FLAGS.has(arg))
  if (hasNoColorFlag && env.NO_COLOR === undefined) {
    env.NO_COLOR = '1'
  }

  if (hasNoColorFlag || env.NO_COLOR !== undefined) {
    env.FORCE_COLOR = '0'
  }
}
