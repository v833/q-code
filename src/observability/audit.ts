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

export interface AuditContext {
  sessionId?: string;
  cwd?: string;
  agent?: HookAgentContext;
}

export interface AuditRecord {
  ts: string;
  seq: number;
  pid: number;
  sessionId?: string;
  cwd?: string;
  agent: HookAgentContext;
  event: AuditEventName;
  payload: Record<string, unknown>;
}

export interface AuditLogger {
  emit(
    event: AuditEventName,
    payload?: Record<string, unknown>,
    ctx?: AuditContext,
  ): void;
  flush(): Promise<void>;
}

export interface AuditLoggerOptions {
  enabled?: boolean;
  auditDir?: string;
  retentionDays?: number;
  maxFileBytes?: number;
  maxQueueSize?: number;
  piiMode?: AuditPiiMode;
  now?: () => Date;
  writeLine?: (filePath: string, line: string) => Promise<void>;
  registerProcessHandlers?: boolean;
  registerSignalHandlers?: boolean;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export type AuditPiiMode = "hash" | "full";

export interface AuditConfig {
  enabled: boolean;
  auditDir: string;
  retentionDays: number;
  maxFileBytes: number;
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

export class NoopAuditLogger implements AuditLogger {
  emit(): void {}
  async flush(): Promise<void> {}
}

export function getAuditLogger(): AuditLogger {
  singleton ??= getAuditConfig().enabled
    ? new NdjsonAuditLogger()
    : new NoopAuditLogger();
  return singleton;
}

export function resetAuditLoggerForTests(logger?: AuditLogger): void {
  singleton = logger;
}

export function setCrashGuardOwnsSignalHandlers(ownsSignals: boolean): void {
  crashGuardOwnsSignalHandlers = ownsSignals;
  if (!ownsSignals) return;
  for (const dispose of auditSignalHandlerDisposers) dispose();
  auditSignalHandlerDisposers.clear();
}

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

export function createMessageSummaryPayload(
  text: string,
): Record<string, unknown> {
  return {
    chars: text.length,
    sha256: sha256(text),
  };
}

export function createTextPayload(
  text: string,
  piiMode: AuditPiiMode = getAuditConfig().piiMode,
): Record<string, unknown> {
  const payload = createMessageSummaryPayload(text);
  if (piiMode === "full") payload.text = text;
  return payload;
}

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
