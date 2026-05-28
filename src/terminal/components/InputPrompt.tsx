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
import { detectPromptCursorMode, type PromptCursorMode } from '../cursor-mode'
import { animeTheme, formatPromptGlyph } from '../theme/index'

/** 底部输入区；忙碌时隐藏。 */
export function InputPrompt({
  value,
  cursor,
  isBusy,
  historySearchLabel,
  hasUndoClear
}: {
  value: string
  cursor: number
  isBusy: boolean
  historySearchLabel?: string
  hasUndoClear?: boolean
}): React.JSX.Element {
  const inputRef = useRef<DOMElement>(null)
  const cursorMode = detectPromptCursorMode()
  const renderedValue = cursorMode === 'inline' ? renderInputWithCursor(value, cursor) : value
  const rows = renderPromptInputRows(renderedValue)
  usePromptCursor({ ref: inputRef, value, cursor, mode: cursorMode, isEnabled: !isBusy })

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
            <Text key={index}>{row.text}</Text>
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
  mode,
  isEnabled
}: {
  ref: React.RefObject<DOMElement>
  value: string
  cursor: number
  mode: PromptCursorMode
  isEnabled: boolean
}): void {
  const { stdout } = useStdout()

  useLayoutEffect(() => {
    if (!stdout.isTTY) return

    if (!isEnabled || mode === 'off') {
      stdout.write(Cursor.hide)
      return
    }

    if (mode === 'inline') {
      stdout.write(Cursor.hide)
      return () => {
        stdout.write(Cursor.show)
      }
    }

    if (!ref.current?.yogaNode) {
      stdout.write(Cursor.hide)
      return
    }

    const inputWidth = Math.max(1, ref.current.yogaNode.getComputedWidth())
    const { row, column } = getInputCursorPosition(value, cursor, inputWidth)
    const position = getAbsolutePosition(ref.current)
    const rootHeight = getRootHeight(ref.current)
    const targetX = Math.max(0, Math.min((stdout.columns || 1) - 1, position.x + column))
    const targetY = position.y + row
    const rowsFromFrameEnd = getCursorRowsFromFrameEnd(rootHeight, targetY)
    let syncTimers: NodeJS.Timeout[] = []
    let hasSavedFrameEnd = false

    const restoreCursor = (): void => {
      for (const timer of syncTimers) clearTimeout(timer)
      syncTimers = []
      if (!hasSavedFrameEnd) return
      stdout.write(`${Cursor.restore}${Cursor.hide}`)
      hasSavedFrameEnd = false
    }

    const syncCursor = (): void => {
      if (hasSavedFrameEnd) stdout.write(Cursor.restore)
      stdout.write(Cursor.save)
      hasSavedFrameEnd = true
      stdout.write(`${Cursor.show}${cursorUp(rowsFromFrameEnd)}${cursorColumn(targetX)}`)
    }

    syncCursor()
    syncTimers = [setTimeout(syncCursor, 0), setTimeout(syncCursor, 40)]

    return restoreCursor
  })
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
  restore: '\u001B8',
  save: '\u001B7',
  show: '\u001B[?25h'
} as const

function cursorColumn(column: number): string {
  return `\u001B[${column + 1}G`
}

function cursorUp(rows: number): string {
  return rows > 0 ? `\u001B[${rows}A` : ''
}
