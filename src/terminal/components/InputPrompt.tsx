/**
 * 多行输入提示符：Ink 渲染文本行，并通过 ANSI 将真实终端光标同步到编辑位置。
 */
import React, { useLayoutEffect, useRef } from 'react'
import { Box, Text, useStdout, type DOMElement } from 'ink'
import {
  getInputCursorPosition,
  renderInputWithCursor,
  renderPromptInputRows
} from '../input'
import { animeTheme, formatPromptGlyph } from '../theme/index'

/** 底部输入区；忙碌时隐藏。 */
export function InputPrompt({
  value,
  cursor,
  isBusy,
  historySearchLabel,
  hasUndoClear,
  useRealCursor
}: {
  value: string
  cursor: number
  isBusy: boolean
  historySearchLabel?: string
  hasUndoClear?: boolean
  useRealCursor?: boolean
}): React.JSX.Element {
  const inputRef = useRef<DOMElement>(null)
  const realCursorEnabled = useRealCursor ?? true
  const rows = renderPromptInputRows(
    realCursorEnabled ? value : renderInputWithCursor(value, cursor),
  )
  usePromptCursor({
    ref: inputRef,
    value,
    cursor,
    isEnabled: !isBusy && realCursorEnabled
  })

  if (isBusy) return <Box />

  return (
    <Box marginTop={1} flexDirection="column">
      {hasUndoClear ? (
        <Text color={animeTheme.textDim}>  Esc 恢复刚清空的输入</Text>
      ) : null}
      {historySearchLabel ? (
        <Text color={animeTheme.sky}>  {historySearchLabel}</Text>
      ) : null}
      <Box>
        <Text color={animeTheme.mint} bold>{formatPromptGlyph()}</Text>
        <Box ref={inputRef} flexDirection="column" flexShrink={1}>
          {rows.map((row, index) => (
            // 末尾补空格，确保内容缩短时不会在终端上残留旧字符（如残留一个 `/`）。
            <Text key={index}>{row.text} </Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

function usePromptCursor({
  ref,
  value,
  cursor,
  isEnabled
}: {
  ref: React.RefObject<DOMElement>
  value: string
  cursor: number
  isEnabled: boolean
}): void {
  const { stdout } = useStdout()

  useLayoutEffect(() => {
    if (!stdout.isTTY) return

    if (!isEnabled) {
      stdout.write(Cursor.hide)
      return
    }

    let syncTimers: NodeJS.Timeout[] = []
    let attempts = 0

    const restoreCursor = (): void => {
      for (const timer of syncTimers) clearTimeout(timer)
      syncTimers = []
    }

    const syncCursor = (): void => {
      // Ink 布局树在首次渲染/动态插入节点时可能短暂未就绪；
      // 这里选择延迟重试同步，而不是直接隐藏光标，避免“光标偶尔不在输入框”。
      if (!ref.current?.yogaNode) {
        stdout.write(Cursor.show)
        scheduleRetry()
        return
      }

      const inputWidth = Math.max(1, ref.current.yogaNode.getComputedWidth())
      if (!Number.isFinite(inputWidth) || inputWidth <= 1) {
        stdout.write(Cursor.show)
        scheduleRetry()
        return
      }
      const { row, column } = getInputCursorPosition(value, cursor, inputWidth)
      const position = getAbsolutePosition(ref.current)
      const rootHeight = getRootHeight(ref.current)
      if (!Number.isFinite(rootHeight) || rootHeight <= 0) {
        stdout.write(Cursor.show)
        scheduleRetry()
        return
      }
      const targetX = Math.max(0, Math.min((stdout.columns || 1) - 1, position.x + column))
      const targetY = position.y + row
      const rowsFromFrameEnd = getCursorRowsFromFrameEnd(rootHeight, targetY)

      // 不使用 save/restore：Windows Terminal 上该序列容易与 Ink/终端自身状态冲突，
      // 造成光标落点偏移甚至触发滚动，直接用相对移动更稳定。
      // 关键：每次同步前先把真实光标“归一化”到一个稳定参考点。
      // 在 Windows Terminal 上，相对的 cursorDown 依赖当前光标位置，容易被 Ink 的帧写入打乱；
      // 使用 CUP（Cursor Position）直接跳到终端底部行（不触发滚动），再按 rowsFromFrameEnd 上移更稳定。
      stdout.write(
        `${Cursor.show}${cursorToBottom()}${cursorUp(rowsFromFrameEnd)}${cursorColumn(targetX)}`,
      )
    }

    const scheduleRetry = (): void => {
      if (attempts >= 8) return
      attempts++
      const delay = attempts <= 2 ? 0 : Math.min(16 * 2 ** (attempts - 3), 250)
      syncTimers.push(setTimeout(syncCursor, delay))
    }

    syncCursor()
    // 额外重试：应对 Windows/Ink 布局稳定更晚的情况。
    syncTimers = [
      ...syncTimers,
      setTimeout(syncCursor, 0),
      setTimeout(syncCursor, 40),
      setTimeout(syncCursor, 120),
      setTimeout(syncCursor, 240)
    ]

    return restoreCursor
  }, [cursor, isEnabled, stdout, value])
}

function getAbsolutePosition(node: DOMElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let current: DOMElement | undefined = node

  while (current?.yogaNode) {
    x += current.yogaNode.getComputedLeft()
    y += current.yogaNode.getComputedTop()
    current = current.parentNode
  }

  return { x, y }
}

function getRootHeight(node: DOMElement): number {
  let current: DOMElement = node
  while (current.parentNode) current = current.parentNode
  return current.yogaNode?.getComputedHeight() ?? 0
}

/**
 * 计算从 Ink 根节点底部到目标 Y 需上移的行数（ANSI `cursorUp`）。
 */
export function getCursorRowsFromFrameEnd(rootHeight: number, targetY: number): number {
  return Math.max(0, rootHeight - targetY)
}

const Cursor = {
  hide: '\u001B[?25l',
  show: '\u001B[?25h'
} as const

function cursorToBottom(): string {
  // CUP: row;col (1-based). 999 会被终端钳制到最后一行；不应触发滚动。
  return `\u001B[999;1H`
}

function cursorColumn(column: number): string {
  return `\u001B[${column + 1}G`
}

function cursorUp(rows: number): string {
  return rows > 0 ? `\u001B[${rows}A` : ''
}
