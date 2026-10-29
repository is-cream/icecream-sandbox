/**
 * Transparent host<->guest bridging.
 *
 * The problem this solves: guest code is often LLM-generated. It calls
 * plain APIs — alert("hi"), localStorage.setItem("k", "v") — and cannot
 * know about any sandbox-specific `host.` object. So instead of asking
 * the guest to learn the sandbox, the sandbox learns the guest's
 * vocabulary: the host declares, in Sandbox.create, which globals exist
 * in the guest realm and what each one does. The guest calls them like
 * normal functions; the sandbox forwards each call to the host.
 *
 * Two crossings, one trust rule — the trusted host defines the entire
 * interface:
 *
 * - Guest -> host ("bridged globals"): `globals: { alert: fn,
 *   localStorage: { getItem: fn, ... } }`. The worker installs these
 *   names in the guest realm; each call crosses the port to the host,
 *   which runs its implementation and returns the result. A name the
 *   host did not configure simply does not exist down there
 *   (ReferenceError, fail closed).
 * - Host -> guest (`sandbox.invoke("a.b.c", arg)`): calls a guest
 *   global by dotted path. Only names in the host's `guestFunctions`
 *   allowlist may be invoked; the path resolves through own
 *   properties only (no prototype chain); the final value must be a
 *   function and is called with its parent object as `this`.
 *
 * Everything crossing either way is JSON. Bridged calls are async by
 * physics (they cross the worker boundary), so the guest always gets
 * a promise back — `await localStorage.getItem("k")`, never the bare
 * call. A host bridge function returning undefined resolves the
 * guest's await with null.
 */

/** A JSON value — the only thing that may cross a bridge call. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One host implementation behind a bridged global. */
export type BridgeFunction = (...args: JsonValue[]) => JsonValue | Promise<JsonValue>;

/** Nested namespace of bridged functions, e.g. localStorage. */
export interface BridgeObject {
  [key: string]: BridgeFunction | BridgeObject;
}

/** The host's `globals` config: functions and nested namespaces. */
export type BridgeGlobals = Record<string, BridgeFunction | BridgeObject>;

/**
 * Shape-only spec of the configured globals. This — not the
 * implementations — is what crosses into the worker: functions cannot
 * be serialized, and the worker must never see host code.
 */
export interface BridgeSpec {
  [key: string]: "function" | BridgeSpec;
}

/** True for a plain object (not an array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the host's `globals` config and build the shape-only spec
 * for the worker. Throws on anything that is not a function or a
 * nested plain object of the same — fail fast at create time, never
 * mid-run.
 */
export function normalizeBridgeGlobals(globals: BridgeGlobals | undefined): BridgeSpec {
  if (globals === undefined) return {};
  if (!isPlainObject(globals)) {
    throw new Error("globals: must be an object mapping names to functions or nested objects");
  }
  const build = (node: Record<string, unknown>, path: string): BridgeSpec => {
    const spec: BridgeSpec = {};
    for (const [key, value] of Object.entries(node)) {
      if (key.length === 0) {
        throw new Error(`globals: empty name at "${path}"`);
      }
      if (key === "__proto__") {
        throw new Error(`globals: "${path === "" ? key : `${path}.${key}`}" is not an allowed name`);
      }
      const here = path === "" ? key : `${path}.${key}`;
      if (typeof value === "function") {
        spec[key] = "function";
      } else if (isPlainObject(value)) {
        spec[key] = build(value as Record<string, unknown>, here);
      } else {
        throw new Error(
          `globals: "${here}" must be a function or a nested object of functions`,
        );
      }
    }
    return spec;
  };
  return build(globals as Record<string, unknown>, "");
}

/** A dotted path like "a.b.c": non-empty segments, no empties. */
export function isDottedPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.split(".").every((segment) => segment.length > 0)
  );
}

/**
 * Validate the host's `guestFunctions` allowlist. Returns a deduped
 * copy, preserving order. Throws on anything that is not a dotted
 * path — fail fast at create time.
 */
export function validateGuestFunctions(list: string[] | undefined): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error("guestFunctions: must be an array of dotted paths");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    if (!isDottedPath(entry)) {
      throw new Error(`guestFunctions: "${String(entry)}" is not a valid dotted path`);
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/** Shape-check a BridgeSpec arriving over the port (worker side). */
export function isBridgeSpec(value: unknown): value is BridgeSpec {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      key.length > 0 &&
      key !== "__proto__" && // fail closed: never let a spec touch the prototype
      (entry === "function" || isBridgeSpec(entry)),
  );
}

/** Shape-check a guestFunctions allowlist arriving over the port. */
export function isGuestFunctionsList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => isDottedPath(entry))
  );
}
