/**
 * 会话模型边界：恢复历史 session 时只提示差异，不让历史模型决定后续请求模型。
 */

/** 恢复 session 后可展示的模型边界提示。 */
export interface SessionModelBoundaryNotice {
  historicalModel: string
  currentModel: string
  text: string
}

/** 构造“历史模型与当前模型不同”的一次性提示。 */
export function createSessionModelBoundaryNotice(args: {
  historicalModel?: string
  currentModel: string
}): SessionModelBoundaryNotice | undefined {
  const historicalModel = normalizeModelName(args.historicalModel)
  const currentModel = normalizeModelName(args.currentModel)
  if (!historicalModel || !currentModel) return undefined
  if (historicalModel === currentModel) return undefined

  return {
    historicalModel,
    currentModel,
    text: [
      '历史模型与当前模型不同；后续新请求将使用当前模型。',
      `历史模型: ${historicalModel}`,
      `当前模型: ${currentModel}`
    ].join('\n')
  }
}

function normalizeModelName(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}
