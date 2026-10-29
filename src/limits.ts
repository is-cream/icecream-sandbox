/**
 * Configurable limits for a guest run. Every field is optional; anything
 * omitted falls back to the safe default. All limits are enforced inside the
 * worker (QuickJS) and, where it makes sense, re-checked on the host.
 *
 * The 256 KiB stack ceiling is not arbitrary: in testing, max stack sizes of
 * 512 KiB or more crashed the host process, so anything larger is rejected
 * outright instead of being clamped silently.
 */
export interface RunLimits {
  /** Wall-clock budget for the run in milliseconds. Default 1000. */
  deadlineMs?: number;
  /** QuickJS heap cap in bytes. Default 16 MiB. */
  memoryLimitBytes?: number;
  /**
   * QuickJS stack size in bytes. Default 256 KiB.
   * Must be 256 KiB or less; larger values throw.
   */
  maxStackSize?: number;
  /** Max size in bytes of any single message crossing the boundary. Default 64 KiB. */
  maxMessageSize?: number;
  /** Max size in bytes of guest code for one run. Default 1 MiB. */
  maxCodeSize?: number;
  /** Max simultaneous outstanding host.ask() calls. Default 8. */
  maxOutstandingAsks?: number;
  /** Max simultaneous outstanding host.fetchText() calls. Default 4. */
  maxOutstandingFetches?: number;
  /** Max total bytes the guest may send to the host during one run. Default 1 MiB. */
  maxTotalOutputBytes?: number;
  /** Max modules fetched for one run's import graph (entry + transitive). Default 64. */
  maxImportModules?: number;
  /** Max import depth: entry imports are depth 0. Default 16. */
  maxImportDepth?: number;
}

export interface ResolvedLimits {
  deadlineMs: number;
  memoryLimitBytes: number;
  maxStackSize: number;
  maxMessageSize: number;
  maxCodeSize: number;
  maxOutstandingAsks: number;
  maxOutstandingFetches: number;
  maxTotalOutputBytes: number;
  maxImportModules: number;
  maxImportDepth: number;
}

export const DEFAULT_LIMITS: ResolvedLimits = {
  deadlineMs: 1000,
  memoryLimitBytes: 16 * 1024 * 1024,
  maxStackSize: 256 * 1024,
  maxMessageSize: 64 * 1024,
  maxCodeSize: 1024 * 1024,
  maxOutstandingAsks: 8,
  maxOutstandingFetches: 4,
  maxTotalOutputBytes: 1024 * 1024,
  maxImportModules: 64,
  maxImportDepth: 16,
};

/** Hard ceiling for maxStackSize: anything above this is rejected, never clamped. */
export const MAX_STACK_SIZE = 256 * 1024;

function positiveInt(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`limit ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export function resolveLimits(input?: RunLimits): ResolvedLimits {
  const limits: ResolvedLimits = {
    deadlineMs: positiveInt("deadlineMs", input?.deadlineMs, DEFAULT_LIMITS.deadlineMs),
    memoryLimitBytes: positiveInt(
      "memoryLimitBytes",
      input?.memoryLimitBytes,
      DEFAULT_LIMITS.memoryLimitBytes,
    ),
    maxStackSize: positiveInt("maxStackSize", input?.maxStackSize, DEFAULT_LIMITS.maxStackSize),
    maxMessageSize: positiveInt(
      "maxMessageSize",
      input?.maxMessageSize,
      DEFAULT_LIMITS.maxMessageSize,
    ),
    maxCodeSize: positiveInt("maxCodeSize", input?.maxCodeSize, DEFAULT_LIMITS.maxCodeSize),
    maxOutstandingAsks: positiveInt(
      "maxOutstandingAsks",
      input?.maxOutstandingAsks,
      DEFAULT_LIMITS.maxOutstandingAsks,
    ),
    maxOutstandingFetches: positiveInt(
      "maxOutstandingFetches",
      input?.maxOutstandingFetches,
      DEFAULT_LIMITS.maxOutstandingFetches,
    ),
    maxTotalOutputBytes: positiveInt(
      "maxTotalOutputBytes",
      input?.maxTotalOutputBytes,
      DEFAULT_LIMITS.maxTotalOutputBytes,
    ),
    maxImportModules: positiveInt(
      "maxImportModules",
      input?.maxImportModules,
      DEFAULT_LIMITS.maxImportModules,
    ),
    maxImportDepth: positiveInt(
      "maxImportDepth",
      input?.maxImportDepth,
      DEFAULT_LIMITS.maxImportDepth,
    ),
  };
  if (limits.maxStackSize > MAX_STACK_SIZE) {
    throw new Error(
      `limit maxStackSize must be 256 KiB or less (${MAX_STACK_SIZE} bytes), got ${limits.maxStackSize} ` +
        `(larger stacks crashed the host in testing)`,
    );
  }
  return limits;
}
