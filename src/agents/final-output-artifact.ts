/**
 * SubAgent 最终产物句柄化：短结果保持内联，长结果写入 artifact 文件并回传 preview。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProjectStorageInfo } from '../context/project-paths'

export const DEFAULT_FINAL_OUTPUT_INLINE_CHAR_LIMIT = 8000
export const DEFAULT_FINAL_OUTPUT_PREVIEW_CHAR_LIMIT = 2000
export const DEFAULT_ERROR_INLINE_CHAR_LIMIT = 4000

/** SubAgent finalText 的控制面描述。 */
export interface FinalOutputReference {
  inlineText?: string
  preview: string
  originalChars: number
  resultTruncated: boolean
  artifactFile?: string
  recoveryHint?: string
}

/** 为 SubAgent finalText 生成可恢复引用，长结果会写入 `.sessions/projects/.../agent-artifacts/`。 */
export async function createFinalOutputReference(params: {
  cwd: string
  sessionId: string
  agentId: string
  finalText: string
  inlineCharLimit?: number
  previewCharLimit?: number
  /** artifact 写入失败时可用于恢复完整结果的 `.output` 文件。 */
  fallbackFile?: string
}): Promise<FinalOutputReference> {
  const inlineLimit = params.inlineCharLimit ?? DEFAULT_FINAL_OUTPUT_INLINE_CHAR_LIMIT
  const previewLimit = params.previewCharLimit ?? DEFAULT_FINAL_OUTPUT_PREVIEW_CHAR_LIMIT
  if (params.finalText.length <= inlineLimit) {
    return {
      inlineText: params.finalText,
      preview: params.finalText,
      originalChars: params.finalText.length,
      resultTruncated: false
    }
  }

  const artifactFile = getFinalOutputArtifactPath({
    cwd: params.cwd,
    sessionId: params.sessionId,
    agentId: params.agentId
  })
  const preview = createHeadTailPreview(params.finalText, previewLimit)
  try {
    await fs.mkdir(path.dirname(artifactFile), { recursive: true })
    await fs.writeFile(artifactFile, params.finalText, 'utf-8')
  } catch (error) {
    return {
      preview,
      originalChars: params.finalText.length,
      resultTruncated: true,
      recoveryHint: params.fallbackFile
        ? `artifact 写入失败（${formatArtifactWriteError(error)}）。完整结果仍保存在 output_file，可按需使用 read_file 读取：${params.fallbackFile}`
        : `artifact 写入失败（${formatArtifactWriteError(error)}）。这里只回传 preview；完整结果仍随 SubAgent 返回值提供给调用方。`
    }
  }

  return {
    preview,
    originalChars: params.finalText.length,
    resultTruncated: true,
    artifactFile,
    recoveryHint: `完整结果已写入 artifact_file，可按需使用 read_file 读取：${artifactFile}`
  }
}

/** 计算 SubAgent final artifact 路径（不创建文件）。 */
export function getFinalOutputArtifactPath(params: {
  cwd: string
  sessionId: string
  agentId: string
}): string {
  const storage = getProjectStorageInfo(params.cwd)
  return path.join(
    storage.projectDir,
    'agent-artifacts',
    sanitizeSegment(params.sessionId),
    `${sanitizeSegment(params.agentId)}.final.md`
  )
}

/** 保护失败/kill 错误信息，避免异常文本撑大通知和 hook payload。 */
export function createBoundedText(value: string, maxChars = DEFAULT_ERROR_INLINE_CHAR_LIMIT): {
  text: string
  originalChars: number
  truncated: boolean
} {
  if (value.length <= maxChars) {
    return { text: value, originalChars: value.length, truncated: false }
  }

  return {
    text: `${value.slice(0, maxChars).trimEnd()}\n... [truncated ${value.length - maxChars} chars]`,
    originalChars: value.length,
    truncated: true
  }
}

function createHeadTailPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const headChars = Math.max(1, Math.floor(maxChars * 0.65))
  const tailChars = Math.max(1, maxChars - headChars)
  const omitted = text.length - headChars - tailChars
  return [
    text.slice(0, headChars).trimEnd(),
    '',
    `... [truncated ${omitted} chars; see artifact_file for full result]`,
    '',
    text.slice(text.length - tailChars).trimStart()
  ].join('\n')
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-')
}

function formatArtifactWriteError(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code)
    : undefined
  const message = code ?? (error instanceof Error ? error.message : String(error))
  return createBoundedText(message, 200).text.replace(/\s+/g, ' ').trim()
}
