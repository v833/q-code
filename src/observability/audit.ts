/**
 * NDJSON 审计日志：异步队列写入、按日滚动、PII 脱敏与进程退出刷盘。
 *
 * 默认目录为 `Q_CODE_HOME/logs`（或 `Q_CODE_AUDIT_DIR`），可通过
 * `Q_CODE_AUDIT_ENABLED` 等环境变量配置。工具注册表与 Agent 循环通过
 * `getAuditLogger()` 单例写入 `tool.call` / `tool.result` 等事件。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HookAgentContext } from "../hooks";
import { isFalseEnv } from "../utils/env";

/** 审计事件名称联合类型，覆盖会话、工具、Hook、计划、子 Agent、团队与 MCP 等生命周期。 */
export type AuditEventName =
  | "session.start"
  | "session.end"
  | "session.resume"
  | "user.prompt"
  | "user.mention"
  | "mode.change"
  | "agent.step.start"
  | "agent.step.end"
  | "tool.call"
  | "tool.result"
  | "hook.decision"
  | "plan.markReady"
  | "plan.approve"
  | "plan.revise"
  | "subagent.spawn"
  | "subagent.complete"
  | "subagent.fail"
  | "subagent.kill"
  | "team.create"
  | "team.delete"
  | "team.message"
  | "mcp.connect"
  | "mcp.disconnect"
  | "mcp.tool.invoke"
  | "context.compact"
  | "context.offload"
  | "audit.dropped"
  | "error";

/** 单次 `emit` 可选的上下文：会话、工作目录与 Agent 身份。 */
export interface AuditContext {
  /** 当前会话 ID */
  sessionId?: string;
  /** 进程工作目录 */
  cwd?: string;
  /** Hook 侧 Agent 上下文；缺省时记为 `main` */
  agent?: HookAgentContext;
}

/** 写入 NDJSON 文件的一行审计记录结构。 */
export interface AuditRecord {
  /** ISO 8601 时间戳 */
  ts: string;
  /** 进程内单调递增序号 */
  seq: number;
  /** 写入进程 PID */
  pid: number;
  sessionId?: string;
  cwd?: string;
  agent: HookAgentContext;
  event: AuditEventName;
  payload: Record<string, unknown>;
}

/** 审计日志写入器接口：异步队列 + `flush` 刷盘。 */
export interface AuditLogger {
  /**
   * 入队一条审计事件（启用时）；满队列时按策略丢弃非关键事件。
   *
   * @param event - 事件名
   * @param payload - 事件载荷，默认 `{}`
   * @param ctx - 可选会话/目录/Agent 上下文
   */
  emit(
    event: AuditEventName,
    payload?: Record<string, unknown>,
    ctx?: AuditContext,
  ): void;
  /** 等待队列中所有记录落盘 */
  flush(): Promise<void>;
}

/** `NdjsonAuditLogger` 构造选项，用于测试注入或覆盖配置。 */
export interface AuditLoggerOptions {
  enabled?: boolean;
  auditDir?: string;
  retentionDays?: number;
  maxFileBytes?: number;
  maxQueueSize?: number;
  piiMode?: AuditPiiMode;
  /** 可注入时钟，便于测试 */
  now?: () => Date;
  /** 可注入行写入，便于测试 */
  writeLine?: (filePath: string, line: string) => Promise<void>;
  /** 是否在 `beforeExit`/信号时自动 flush，默认 `true` */
  registerProcessHandlers?: boolean;
  /** 是否注册 SIGINT/SIGTERM 处理；crash guard 接管时为 `false` */
  registerSignalHandlers?: boolean;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

/** PII 模式：`hash` 仅摘要，`full` 保留原文（需显式配置）。 */
export type AuditPiiMode = "hash" | "full";

/** 从环境变量解析后的审计运行时配置。 */
export interface AuditConfig {
  /** 是否写入审计日志 */
  enabled: boolean;
  /** 审计文件目录（绝对路径） */
  auditDir: string;
  /** 过期文件保留天数，启动时清理 */
  retentionDays: number;
  /** 单个 NDJSON 文件大小上限（字节） */
  maxFileBytes: number;
  /** 内存队列最大条数，溢出时丢弃 */
  maxQueueSize: number;
  piiMode: AuditPiiMode;
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const AUDIT_DATE_RE = /^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.ndjson$/;

let singleton: AuditLogger | undefined;
let crashGuardOwnsSignalHandlers = false;
const auditSignalHandlerDisposers = new Set<() => void>();

/**
 * 将审计记录异步写入按日滚动的 NDJSON 文件。
 *
 * 队列溢出时优先丢弃非关键事件，并可能写入 `audit.dropped` 汇总行。
 */
export class NdjsonAuditLogger implements AuditLogger {
  private readonly config: AuditConfig;
  private readonly now: () => Date;
  private readonly writeLine: (filePath: string, line: string) => Promise<void>;
  private readonly stderr: Pick<NodeJS.WriteStream, "write">;
  private queue: AuditRecord[] = [];
  private draining: Promise<void> | undefined;
  private seq = 0;
  private lastFilePath = "";
  private lastFileBytes = 0;
  private droppedSinceLastNotice = 0;

  /**
   * @param options - 覆盖 `getAuditConfig()` 默认值及进程退出钩子行为
   */
  constructor(options: AuditLoggerOptions = {}) {
    this.config = {
      ...getAuditConfig(),
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.auditDir ? { auditDir: resolve(options.auditDir) } : {}),
      ...(options.retentionDays !== undefined
        ? { retentionDays: options.retentionDays }
        : {}),
      ...(options.maxFileBytes !== undefined
        ? { maxFileBytes: options.maxFileBytes }
        : {}),
      ...(options.maxQueueSize !== undefined
        ? { maxQueueSize: options.maxQueueSize }
        : {}),
      ...(options.piiMode ? { piiMode: options.piiMode } : {}),
    };
    this.now = options.now ?? (() => new Date());
    this.writeLine = options.writeLine ?? defaultWriteLine;
    this.stderr = options.stderr ?? process.stderr;

    if (this.config.enabled) {
      mkdirSync(this.config.auditDir, { recursive: true });
      cleanupExpiredAuditFiles(
        this.config.auditDir,
        this.config.retentionDays,
        this.now(),
      );
    }
    if (options.registerProcessHandlers !== false) {
      registerAuditProcessFlush(this, {
        registerSignalHandlers:
          options.registerSignalHandlers ?? !crashGuardOwnsSignalHandlers,
      });
    }
  }

  emit(
    event: AuditEventName,
    payload: Record<string, unknown> = {},
    ctx: AuditContext = {},
  ): void {
    if (!this.config.enabled) return;

    const record: AuditRecord = {
      ts: this.now().toISOString(),
      seq: ++this.seq,
      pid: process.pid,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      agent: normalizeAgent(ctx.agent),
      event,
      payload,
    };

    this.enqueue(record);
  }

  async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      const current = this.draining ?? this.drain();
      await current;
    }
  }

  private enqueue(record: AuditRecord): void {
    if (this.queue.length >= this.config.maxQueueSize) {
      this.dropOneQueuedRecord();
    }
    if (this.droppedSinceLastNotice > 0) {
      while (this.queue.length >= Math.max(0, this.config.maxQueueSize - 1)) {
        this.dropOneQueuedRecord();
      }
      this.queue.push(this.createDroppedRecord(record));
      this.droppedSinceLastNotice = 0;
    }
    this.queue.push(record);
    this.scheduleDrain();
  }

  private dropOneQueuedRecord(): void {
    const index = this.queue.findIndex((item) => !isCriticalEvent(item.event));
    const [dropped] = this.queue.splice(index >= 0 ? index : 0, 1);
    this.droppedSinceLastNotice++;
    if (!dropped || dropped.event === "audit.dropped") return;
  }

  private createDroppedRecord(reference: AuditRecord): AuditRecord {
    return {
      ts: this.now().toISOString(),
      seq: ++this.seq,
      pid: process.pid,
      ...(reference.sessionId ? { sessionId: reference.sessionId } : {}),
      ...(reference.cwd ? { cwd: reference.cwd } : {}),
      agent: reference.agent,
      event: "audit.dropped",
      payload: {
        dropped: this.droppedSinceLastNotice,
        reason: "queue_overflow",
      },
    };
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.length > 0) this.scheduleDrain();
    });
    this.draining.catch((error) => {
      this.stderr.write(`[audit] 写入失败: ${formatError(error)}\n`);
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const record = this.queue.shift();
      if (!record) continue;
      try {
        const line = `${JSON.stringify(record)}\n`;
        const filePath = await this.resolveWritePath(
          Buffer.byteLength(line, "utf-8"),
          record.ts,
        );
        await this.writeLine(filePath, line);
        this.lastFilePath = filePath;
        this.lastFileBytes += Buffer.byteLength(line, "utf-8");
      } catch (error) {
        this.stderr.write(`[audit] 写入失败: ${formatError(error)}\n`);
      }
    }
  }

  private async resolveWritePath(
    nextBytes: number,
    timestamp: string,
  ): Promise<string> {
    const date = timestamp.slice(0, 10);
    let suffix = 0;
    while (true) {
      const filePath = join(
        this.config.auditDir,
        formatAuditFileName(date, suffix),
      );
      const size = await this.getKnownFileSize(filePath);
      if (size === 0 || size + nextBytes <= this.config.maxFileBytes) {
        this.lastFilePath = filePath;
        this.lastFileBytes = size;
        return filePath;
      }
      suffix++;
    }
  }

  private async getKnownFileSize(filePath: string): Promise<number> {
    if (this.lastFilePath === filePath) return this.lastFileBytes;
    try {
      return (await stat(filePath)).size;
    } catch {
      return 0;
    }
  }
}

/** 审计关闭时的空实现，不写入磁盘。 */
export class NoopAuditLogger implements AuditLogger {
  emit(): void {}
  async flush(): Promise<void> {}
}

/**
 * 获取进程级审计日志单例（启用时为 `NdjsonAuditLogger`）。
 *
 * @returns 全局 `AuditLogger` 实例
 */
export function getAuditLogger(): AuditLogger {
  singleton ??= getAuditConfig().enabled
    ? new NdjsonAuditLogger()
    : new NoopAuditLogger();
  return singleton;
}

/**
 * 测试用：替换或清空审计单例。
 *
 * @param logger - 注入实例；`undefined` 表示下次 `getAuditLogger` 重新创建
 */
export function resetAuditLoggerForTests(logger?: AuditLogger): void {
  singleton = logger;
}

/**
 * 声明 crash guard 已注册信号处理，避免审计与 guard 重复监听 SIGINT/SIGTERM。
 *
 * @param ownsSignals - `true` 时移除审计已注册的信号监听器
 */
export function setCrashGuardOwnsSignalHandlers(ownsSignals: boolean): void {
  crashGuardOwnsSignalHandlers = ownsSignals;
  if (!ownsSignals) return;
  for (const dispose of auditSignalHandlerDisposers) dispose();
  auditSignalHandlerDisposers.clear();
}

/**
 * 从环境变量解析审计配置（目录、保留天数、队列与 PII 模式等）。
 *
 * @param env - 环境变量对象，默认 `process.env`
 * @returns 完整 `AuditConfig`
 */
export function getAuditConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuditConfig {
  const qCodeHome = env.Q_CODE_HOME?.trim()
    ? resolve(env.Q_CODE_HOME)
    : join(homedir(), ".q-code");
  return {
    enabled: !isFalseEnv(env.Q_CODE_AUDIT_ENABLED),
    auditDir: resolve(env.Q_CODE_AUDIT_DIR?.trim() || join(qCodeHome, "logs")),
    retentionDays: getPositiveIntEnv(
      env.Q_CODE_AUDIT_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
    ),
    maxFileBytes: getPositiveIntEnv(
      env.Q_CODE_AUDIT_MAX_FILE_BYTES,
      DEFAULT_MAX_FILE_BYTES,
    ),
    maxQueueSize: getPositiveIntEnv(
      env.Q_CODE_AUDIT_MAX_QUEUE_SIZE,
      DEFAULT_MAX_QUEUE_SIZE,
    ),
    piiMode:
      env.Q_CODE_AUDIT_PII?.trim().toLowerCase() === "full" ? "full" : "hash",
  };
}

/**
 * 构造 `user.prompt` 载荷：始终含字符数与 SHA-256；`full` 模式附加原文。
 *
 * @param text - 用户输入文本
 * @param piiMode - PII 模式，默认来自 `getAuditConfig()`
 */
export function createUserPromptPayload(
  text: string,
  piiMode = getAuditConfig().piiMode,
) {
  const chars = text.length;
  const payload: Record<string, unknown> = {
    chars,
    sha256: sha256(text),
  };
  if (piiMode === "full") payload.text = text;
  return payload;
}

/**
 * 构造 `tool.call` 载荷：工具名、输入摘要/长度，可选 `toolCallId` 与完整 input。
 *
 * @param args - 工具名、输入及可选 PII 模式
 */
export function createToolCallPayload(args: {
  name: string;
  toolCallId?: string;
  input: unknown;
  piiMode?: AuditPiiMode;
}): Record<string, unknown> {
  const text = safeStringify(args.input);
  const payload: Record<string, unknown> = {
    name: args.name,
    inputDigest: sha256(text),
    inputChars: text.length,
  };
  if (args.toolCallId) payload.toolCallId = args.toolCallId;
  if ((args.piiMode ?? getAuditConfig().piiMode) === "full")
    payload.input = args.input;
  return payload;
}

/**
 * 构造 `tool.result` 载荷：成功标志、输出摘要/长度，可选耗时与完整 output。
 *
 * @param args - 工具名、输出、错误码与 PII 相关字段
 */
export function createToolResultPayload(args: {
  name: string;
  toolCallId?: string;
  output: unknown;
  ok: boolean;
  isError?: boolean;
  code?: string;
  durationMs?: number;
  piiMode?: AuditPiiMode;
}): Record<string, unknown> {
  const text =
    typeof args.output === "string" ? args.output : safeStringify(args.output);
  const payload: Record<string, unknown> = {
    name: args.name,
    ok: args.ok,
    isError: args.isError === true,
    resultLength: text.length,
    outputDigest: sha256(text),
  };
  if (args.toolCallId) payload.toolCallId = args.toolCallId;
  if (args.code) payload.code = args.code;
  if (args.durationMs !== undefined) payload.durationMs = args.durationMs;
  if ((args.piiMode ?? getAuditConfig().piiMode) === "full")
    payload.output = args.output;
  return payload;
}

/**
 * 构造仅含字符数与 SHA-256 的文本摘要载荷（不含原文）。
 *
 * @param text - 待摘要文本
 */
export function createMessageSummaryPayload(
  text: string,
): Record<string, unknown> {
  return {
    chars: text.length,
    sha256: sha256(text),
  };
}

/**
 * 构造通用文本载荷：摘要 + 可选在 `full` 模式下附加 `text` 字段。
 *
 * @param text - 原始文本
 * @param piiMode - PII 模式，默认来自配置
 */
export function createTextPayload(
  text: string,
  piiMode: AuditPiiMode = getAuditConfig().piiMode,
): Record<string, unknown> {
  const payload = createMessageSummaryPayload(text);
  if (piiMode === "full") payload.text = text;
  return payload;
}

/**
 * 构造 `hook.decision` 载荷；`reason` / `message` 经 `createTextPayload` 脱敏。
 *
 * @param args - Hook 元数据、匹配结果与可选说明文本
 */
export function createHookDecisionPayload(args: {
  hookName: string;
  event: string;
  scope: string;
  matched: boolean;
  action: string;
  durationMs: number;
  reason?: string;
  message?: string;
  piiMode?: AuditPiiMode;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    hookName: args.hookName,
    event: args.event,
    scope: args.scope,
    matched: args.matched,
    action: args.action,
    durationMs: args.durationMs,
  };
  if (args.reason !== undefined) {
    payload.reason = createTextPayload(args.reason, args.piiMode);
  }
  if (args.message !== undefined) {
    payload.message = createTextPayload(args.message, args.piiMode);
  }
  return payload;
}

/**
 * 规范化审计上下文：补全默认 Agent，剔除空字段。
 *
 * @param ctx - 原始上下文
 */
export function auditContext(ctx: AuditContext): AuditContext {
  return {
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    agent: normalizeAgent(ctx.agent),
  };
}

function normalizeAgent(agent: HookAgentContext | undefined): HookAgentContext {
  return agent ?? { kind: "main" };
}

function isCriticalEvent(event: AuditEventName): boolean {
  return (
    event === "session.start" ||
    event === "session.end" ||
    event === "session.resume" ||
    event === "tool.call" ||
    event === "error" ||
    event === "audit.dropped"
  );
}

function cleanupExpiredAuditFiles(
  auditDir: string,
  retentionDays: number,
  now: Date,
): void {
  if (retentionDays <= 0 || !existsSync(auditDir)) return;
  const cutoff =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    retentionDays * 86400_000;

  for (const name of readdirSync(auditDir)) {
    const match = name.match(AUDIT_DATE_RE);
    if (!match) continue;
    const fileDate = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(fileDate) || fileDate >= cutoff) continue;
    try {
      unlinkSync(join(auditDir, name));
    } catch {
      // Best-effort retention cleanup.
    }
  }
}

function registerAuditProcessFlush(
  logger: AuditLogger,
  options: { registerSignalHandlers: boolean },
): void {
  let signalFlushStarted = false;
  const flushBeforeExit = () => {
    void logger.flush();
  };
  const flushAndExit = (signal: "SIGINT" | "SIGTERM") => {
    if (signalFlushStarted) return;
    signalFlushStarted = true;
    const exitCode = signal === "SIGINT" ? 130 : 143;
    void Promise.race([logger.flush(), sleep(2000)]).finally(() => {
      process.exit(exitCode);
    });
  };
  process.once("beforeExit", flushBeforeExit);
  if (!options.registerSignalHandlers) return;
  const onSigint = () => flushAndExit("SIGINT");
  const onSigterm = () => flushAndExit("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  auditSignalHandlerDisposers.add(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  });
}

function formatAuditFileName(date: string, suffix: number): string {
  return suffix === 0
    ? `audit-${date}.ndjson`
    : `audit-${date}.${suffix}.ndjson`;
}

async function defaultWriteLine(filePath: string, line: string): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });
  await appendFile(filePath, line, "utf-8");
}

function getPositiveIntEnv(value: string | undefined, fallback: number): number;
function getPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number;
function getPositiveIntEnv(
  envOrValue: NodeJS.ProcessEnv | string | undefined,
  nameOrFallback: string | number,
  maybeFallback?: number,
): number {
  const raw =
    typeof nameOrFallback === "string"
      ? (envOrValue as NodeJS.ProcessEnv)[nameOrFallback]
      : envOrValue;
  const fallback =
    typeof nameOrFallback === "number" ? nameOrFallback : maybeFallback!;
  const value = Number(
    String(raw ?? "")
      .trim()
      .replace(/_/g, ""),
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 安全 JSON 序列化：循环引用替换为 `[Circular]`，失败时回退 `String(value)`。
 *
 * @param value - 任意可序列化值
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item !== "object" || item === null) return item;
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
      return item;
    });
  } catch {
    return String(value);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
