/**
 * The wire protocol between host and worker.
 *
 * Everything crossing a boundary is a JSON string — never an object, handle,
 * or function. Both sides validate shape before touching any field, and
 * anything malformed is ignored (fail closed) rather than acted on.
 */
import type { ResolvedLimits } from "./limits.js";
import type { ImportMap } from "./imports.js";
import { isBridgeSpec, isGuestFunctionsList, type BridgeSpec } from "./bridge.js";

/** Host -> worker. */
export type HostToWorkerMessage =
  | { t: "run"; id: number; code: string; limits: ResolvedLimits; imports: ImportMap; bridge?: BridgeSpec | undefined; guestFunctions?: string[] | undefined }
  | { t: "send"; message: string }
  | { t: "ask-result"; id: number; value: string }
  | { t: "ask-error"; id: number; error: string }
  | { t: "connection-result"; id: number; value: string }
  | { t: "connection-error"; id: number; error: string }
  | { t: "import-result"; id: number; value: string }
  | { t: "import-error"; id: number; error: string }
  | { t: "bridge-result"; id: number; value: string }
  | { t: "bridge-error"; id: number; error: string }
  | { t: "invoke-guest"; id: number; path: string; arg: string }
  | { t: "dispose" };

/** Worker -> host. */
export type WorkerToHostMessage =
  | { t: "ready"; nonce: string }
  | { t: "result"; id: number; value: string }
  | { t: "error"; id: number; error: string }
  | { t: "message"; message: string }
  | { t: "ask"; id: number; name: string; arg: string }
  | { t: "connection-request"; id: number; url: string }
  | { t: "import-request"; id: number; url: string }
  | { t: "bridge-call"; id: number; path: string; args: string }
  | { t: "invoke-result"; id: number; value: string }
  | { t: "invoke-error"; id: number; error: string }
  | { t: "guest-error"; error: string };

export function encodeMessage(message: HostToWorkerMessage | WorkerToHostMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse and shape-check one inbound message. Returns the message, or null
 * when it is malformed (oversized, not JSON, not an object, unknown type,
 * or wrong field types). Callers ignore null — they never throw on it, so a
 * hostile or buggy peer cannot crash the receiver by sending garbage.
 */
export function decodeMessage(
  raw: unknown,
  maxBytes: number,
): HostToWorkerMessage | WorkerToHostMessage | null {
  if (typeof raw !== "string") return null;
  if (raw.length > maxBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["t"] !== "string") return null;
  switch (record["t"]) {
    case "run":
      return typeof record["id"] === "number" &&
        typeof record["code"] === "string" &&
        isResolvedLimits(record["limits"]) &&
        isImportMap(record["imports"]) &&
        (record["bridge"] === undefined || isBridgeSpec(record["bridge"])) &&
        (record["guestFunctions"] === undefined || isGuestFunctionsList(record["guestFunctions"]))
        ? {
            t: "run",
            id: record["id"],
            code: record["code"],
            limits: record["limits"],
            imports: record["imports"],
            bridge: isBridgeSpec(record["bridge"]) ? record["bridge"] : undefined,
            guestFunctions: isGuestFunctionsList(record["guestFunctions"])
              ? record["guestFunctions"]
              : undefined,
          }
        : null;
    case "send":
      return typeof record["message"] === "string" ? { t: "send", message: record["message"] } : null;
    case "ask-result":
      return typeof record["id"] === "number" && typeof record["value"] === "string"
        ? { t: "ask-result", id: record["id"], value: record["value"] }
        : null;
    case "ask-error":
      return typeof record["id"] === "number" && typeof record["error"] === "string"
        ? { t: "ask-error", id: record["id"], error: record["error"] }
        : null;
    case "connection-result":
      return typeof record["id"] === "number" && typeof record["value"] === "string"
        ? { t: "connection-result", id: record["id"], value: record["value"] }
        : null;
    case "connection-error":
      return typeof record["id"] === "number" && typeof record["error"] === "string"
        ? { t: "connection-error", id: record["id"], error: record["error"] }
        : null;
    case "import-result":
      return typeof record["id"] === "number" && typeof record["value"] === "string"
        ? { t: "import-result", id: record["id"], value: record["value"] }
        : null;
    case "import-error":
      return typeof record["id"] === "number" && typeof record["error"] === "string"
        ? { t: "import-error", id: record["id"], error: record["error"] }
        : null;
    case "dispose":
      return { t: "dispose" };
    case "bridge-result":
      return typeof record["id"] === "number" && typeof record["value"] === "string"
        ? { t: "bridge-result", id: record["id"], value: record["value"] }
        : null;
    case "bridge-error":
      return typeof record["id"] === "number" && typeof record["error"] === "string"
        ? { t: "bridge-error", id: record["id"], error: record["error"] }
        : null;
    case "invoke-guest":
      return typeof record["id"] === "number" &&
        typeof record["path"] === "string" &&
        typeof record["arg"] === "string"
        ? { t: "invoke-guest", id: record["id"], path: record["path"], arg: record["arg"] }
        : null;
    case "ready":
      return typeof record["nonce"] === "string" ? { t: "ready", nonce: record["nonce"] } : null;
    case "result":
      return typeof record["id"] === "number" && typeof record["value"] === "string"
        ? { t: "result", id: record["id"], value: record["value"] }
        : null;
    case "error":
      return typeof record["id"] === "number" && typeof record["error"] === "string"
        ? { t: "error", id: record["id"], error: record["error"] }
        : null;
    case "message":
      return typeof record["message"] === "string"
        ? { t: "message", message: record["message"] }
        : null;
    case "ask":
      return typeof record["id"] === "number" &&
        typeof record["name"] === "string" &&
        typeof record["arg"] === "string"
        ? { t: "ask", id: record["id"], name: record["name"], arg: record["arg"] }
        : null;
    case "connection-request":
      return typeof record["id"] === "number" && typeof record["url"] === "string"
        ? { t: "connection-request", id: record["id"], url: record["url"] }
        : null;
    case "import-request":
      return typeof record["id"] === "number" && typeof record["url"] === "string"
        ? { t: "import-request", id: record["id"], url: record["url"] }
        : null;
    case "bridge-call":
      return typeof record["id"] === "number" &&
        typeof record["path"] === "string" &&
        typeof record["args"] === "string"
        ? { t: "bridge-call", id: record["id"], path: record["path"], args: record["args"] }
        : null;
    case "invoke-result":
      return typeof record["id"] === "number" && typeof record["value"] === "string"
        ? { t: "invoke-result", id: record["id"], value: record["value"] }
        : null;
    case "invoke-error":
      return typeof record["id"] === "number" && typeof record["error"] === "string"
        ? { t: "invoke-error", id: record["id"], error: record["error"] }
        : null;
    case "guest-error":
      return typeof record["error"] === "string"
        ? { t: "guest-error", error: record["error"] }
        : null;
    default:
      return null;
  }
}

function isResolvedLimits(value: unknown): value is ResolvedLimits {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const fields = [
    "deadlineMs",
    "memoryLimitBytes",
    "maxStackSize",
    "maxMessageSize",
    "maxCodeSize",
    "maxOutstandingAsks",
    "maxOutstandingFetches",
    "maxTotalOutputBytes",
    "maxImportModules",
    "maxImportDepth",
  ];
  return fields.every((field) => typeof record[field] === "number");
}

function isImportMap(value: unknown): value is ImportMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "string",
  );
}
