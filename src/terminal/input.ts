/**
 * 多行提示符输入状态机：纯函数更新光标/历史/粘贴，并提供终端光标定位辅助。
 */
import { graphemeDisplayWidth, splitGraphemes } from './utils/string-width';

/** 提示符编辑区的不可变状态。 */
export interface InputState {
  /** 当前编辑区文本（可含换行）。 */
  value: string;
  /** 光标位置，按字素簇计数。 */
  cursor: number;
  /** 已提交输入的历史列表（最新在末尾）。 */
  history: string[];
  /** 历史浏览模式下的当前索引；未浏览时为 `undefined`。 */
  historyIndex?: number;
  /** Ctrl+R 反向搜索时固定的查询串。 */
  historySearchQuery?: string;
  /** 反向搜索当前命中的历史索引。 */
  historySearchIndex?: number;
  /** Esc 清空后暂存、以便再次 Esc 恢复的内容。 */
  clearedValue?: string;
  /** 与 {@link InputState.clearedValue} 对应的光标位置。 */
  clearedCursor?: number;
}

/** 创建空输入状态，可带入历史列表。 */
export function createInputState(history: string[] = []): InputState {
  return {
    value: '',
    cursor: 0,
    history,
  };
}

/** 在光标处插入文本（含粘贴规范化与字素簇光标）。 */
export function insertText(state: InputState, text: string): InputState {
  if (!text) return state;
  const chars = splitChars(state.value);
  const normalizedText = normalizePastedText(text);
  const insertChars = splitChars(normalizedText);
  const before = chars.slice(0, state.cursor).join('');
  const after = chars.slice(state.cursor).join('');
  return {
    ...clearTransientInputState(state),
    value: before + normalizedText + after,
    cursor: state.cursor + insertChars.length,
    historyIndex: undefined,
  };
}

/** 按字素簇偏移移动光标。 */
export function moveCursor(state: InputState, delta: number): InputState {
  const cursor = Math.max(
    0,
    Math.min(splitChars(state.value).length, state.cursor + delta),
  );
  return { ...state, cursor };
}

/** 删除光标前一个 grapheme。 */
export function backspace(state: InputState): InputState {
  if (state.cursor === 0) return state;
  const chars = splitChars(state.value);
  chars.splice(state.cursor - 1, 1);
  return {
    ...clearTransientInputState(state),
    value: chars.join(''),
    cursor: state.cursor - 1,
    historyIndex: undefined,
  };
}

/** 删除光标后一个 grapheme。 */
export function deleteForward(state: InputState): InputState {
  const chars = splitChars(state.value);
  if (state.cursor >= chars.length) return state;
  chars.splice(state.cursor, 1);
  return {
    ...clearTransientInputState(state),
    value: chars.join(''),
    historyIndex: undefined,
  };
}

/** 插入换行（多行输入）。 */
export function newline(state: InputState): InputState {
  return insertText(state, '\n');
}

/**
 * 将 `[start, end)` 字素簇区间替换为 `text`（如斜杠补全覆盖 `@file` token）。
 *
 * @param start - 替换起点（含），按字素簇索引。
 * @param end - 替换终点（不含），按字素簇索引。
 */
export function replaceRange(
  state: InputState,
  start: number,
  end: number,
  text: string,
): InputState {
  const chars = splitChars(state.value);
  const safeStart = Math.max(0, Math.min(chars.length, start));
  const safeEnd = Math.max(safeStart, Math.min(chars.length, end));
  const insertChars = splitChars(text);
  return {
    ...clearTransientInputState(state),
    value: `${chars.slice(0, safeStart).join('')}${text}${chars.slice(safeEnd).join('')}`,
    cursor: safeStart + insertChars.length,
    historyIndex: undefined,
  };
}

/**
 * 提交当前输入：返回 trim 后的字符串，并重置编辑区、更新历史（最多 100 条）。
 */
export function submitInput(state: InputState): {
  input: string;
  state: InputState;
} {
  const input = state.value.trimEnd();
  const history = input.trim()
    ? [...state.history.filter((entry) => entry !== input), input].slice(-100)
    : state.history;
  return {
    input,
    state: {
      value: '',
      cursor: 0,
      history,
      historyIndex: undefined,
    },
  };
}

/** 上箭头：浏览更早的历史条目。 */
export function recallPrevious(state: InputState): InputState {
  if (state.history.length === 0) return state;
  const currentIndex = state.historyIndex ?? state.history.length;
  const historyIndex = Math.max(0, currentIndex - 1);
  const value = state.history[historyIndex] ?? '';
  return {
    ...clearTransientInputState(state),
    value,
    cursor: splitChars(value).length,
    historyIndex,
  };
}

/** 下箭头：浏览更新的历史条目，越过末尾则清空。 */
export function recallNext(state: InputState): InputState {
  if (state.history.length === 0 || state.historyIndex === undefined)
    return state;
  const historyIndex = state.historyIndex + 1;
  if (historyIndex >= state.history.length) {
    return {
      ...clearTransientInputState(state),
      value: '',
      cursor: 0,
      historyIndex: undefined,
    };
  }
  const value = state.history[historyIndex] ?? '';
  return {
    ...clearTransientInputState(state),
    value,
    cursor: splitChars(value).length,
    historyIndex,
  };
}

/** 在光标位置插入块光标字符 `█`（调试用，TUI 使用真实终端光标）。 */
export function renderInputWithCursor(value: string, cursor: number): string {
  const chars = splitChars(value);
  const safeCursor = Math.max(0, Math.min(chars.length, cursor));
  if (chars.length === 0) return '█';
  return `${chars.slice(0, safeCursor).join('')}█${chars.slice(safeCursor).join('')}`;
}

/** 空值渲染为单空格，避免 Ink 折叠空行。 */
export function renderInputValue(value: string): string {
  return value || ' ';
}

/** 多行提示符的一行展示数据。 */
export interface PromptInputRow {
  text: string;
}

/** 将输入值拆成多行 {@link PromptInputRow}。 */
export function renderPromptInputRows(value: string): PromptInputRow[] {
  const lines = renderInputValue(value).split('\n');
  return lines.map((line) => ({ text: line || ' ' }));
}

/**
 * Esc：有内容则清空并记住以便恢复；已空且有 `clearedValue` 则恢复。
 */
export function clearOrRestoreInput(state: InputState): InputState {
  if (!state.value && state.clearedValue !== undefined) {
    const value = state.clearedValue;
    return {
      ...clearTransientInputState(state),
      value,
      cursor: Math.max(
        0,
        Math.min(
          splitChars(value).length,
          state.clearedCursor ?? splitChars(value).length,
        ),
      ),
      clearedValue: undefined,
      clearedCursor: undefined,
      historyIndex: undefined,
    };
  }

  if (!state.value) return state;
  return {
    ...clearTransientInputState(state),
    value: '',
    cursor: 0,
    historyIndex: undefined,
    clearedValue: state.value,
    clearedCursor: state.cursor,
  };
}

/** Ctrl+R：按当前查询串反向搜索历史，无查询则等同 {@link recallPrevious}。 */
export function searchHistoryPrevious(state: InputState): InputState {
  if (state.history.length === 0) return state;
  const query = state.historySearchQuery ?? state.value.trim();
  if (!query) return recallPrevious(state);

  const start = state.historySearchIndex ?? state.history.length;
  const match = findPreviousHistoryMatch(state.history, query, start);
  if (match === -1) return state;

  const value = state.history[match] ?? '';
  return {
    ...state,
    value,
    cursor: splitChars(value).length,
    historyIndex: match,
    historySearchQuery: query,
    historySearchIndex: match,
  };
}

/**
 * 根据字素簇与软换行宽度计算光标所在的行/列（供 ANSI 光标同步）。
 */
export function getInputCursorPosition(
  value: string,
  cursor: number,
  wrapWidth = Number.POSITIVE_INFINITY,
): { row: number; column: number } {
  const chars = splitChars(value);
  const safeCursor = Math.max(0, Math.min(chars.length, cursor));
  const safeWrapWidth = Number.isFinite(wrapWidth)
    ? Math.max(1, Math.floor(wrapWidth))
    : wrapWidth;
  let row = 0;
  let column = 0;

  for (const char of chars.slice(0, safeCursor)) {
    if (char === '\n') {
      row += 1;
      column = 0;
      continue;
    }

    const width = getDisplayWidth(char);
    if (column > 0 && column + width > safeWrapWidth) {
      row += 1;
      column = 0;
    }
    column += width;
  }

  return { row, column };
}

/** 将粘贴文本中的 CRLF/CR 统一为 LF。 */
export function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function findPreviousHistoryMatch(
  history: readonly string[],
  query: string,
  start: number,
): number {
  for (let index = start - 1; index >= 0; index--) {
    if (history[index]?.includes(query)) return index;
  }
  for (let index = history.length - 1; index >= start; index--) {
    if (history[index]?.includes(query)) return index;
  }
  return -1;
}

function clearTransientInputState(state: InputState): InputState {
  const {
    historySearchQuery: _historySearchQuery,
    historySearchIndex: _historySearchIndex,
    clearedValue: _clearedValue,
    clearedCursor: _clearedCursor,
    ...stable
  } = state;
  return stable;
}

function splitChars(value: string): string[] {
  return splitGraphemes(value);
}

function getDisplayWidth(value: string): number {
  return graphemeDisplayWidth(value);
}
