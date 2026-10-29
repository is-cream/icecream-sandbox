/**
 * Guest ES module imports.
 *
 * Guest code may use static `import` statements (and `export ... from`
 * re-exports). There is no npm install step in a browser: an import is
 * resolved to a URL, the host downloads the module source through the
 * connection gate (one human-in-the-loop approval per origin, then
 * session grants apply), and the source is cached on the Sandbox so a
 * second import of the same URL downloads nothing and prompts nobody.
 *
 * How it works, and why it is built this way:
 *
 * - The worker pre-fetches the whole static import graph BEFORE
 *   evaluating anything. QuickJS's module loader is synchronous — it
 *   cannot await a fetch — so fetching happens up front, over the
 *   port, where async is natural. The loader then serves sources from
 *   the pre-fetched map, and evaluation uses real QuickJS module
 *   semantics (real imports/exports, no source rewriting).
 * - Static imports and string-literal dynamic imports are both
 *   pre-fetched: `import('d3-format')` is a graph edge exactly like a
 *   static import, so it works at runtime — the module evaluates
 *   lazily when `import()` runs, even though its download happened up
 *   front with the rest of the graph. Only a COMPUTED specifier
 *   (`import(name)`, where `name` is a variable) cannot be
 *   pre-fetched; for those, the guest calls `host.importModule(name)`
 *   instead, which downloads through the same gate and cache at call
 *   time and resolves with the module's namespace.
 * - Relative imports are resolved against the importing module's URL,
 *   so a fetched module can import its own siblings. The entry module
 *   has no URL, so a relative import in guest entry code is an error
 *   with a clear message — map entry imports in the import map instead.
 * - Imported code runs inside the same guest realm with the same
 *   limits as any guest code. Importing does not grant new powers:
 *   the module's network still goes through the gate, and it has no
 *   DOM, storage, or host objects.
 *
 * The scanner is a single-pass tokenizer, not a full parser: it skips
 * comments and string literals, so an `import` mentioned in a comment
 * or a string is not treated as a real import. Pathological syntax
 * (import statements generated inside template expressions, for
 * example) is outside what the scanner promises: a missed import fails
 * at evaluation with the specifier named, and an over-fetched one only
 * costs a gate-approved download that is never loaded.
 */

/** An import map: bare specifier -> absolute module URL (pinned version). */
export type ImportMap = Record<string, string>;

/**
 * The module specifiers in static import statements and `export ... from`
 * re-exports, in first-seen order, deduplicated. Returns [] for classic
 * scripts with no module syntax.
 */
export function scanModuleSpecifiers(code: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // One alternation: comments and string literals are consumed and
  // ignored; only real import/export-from statements produce a match.
  const token =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\b(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s+)?(['"])((?:(?!\1).)+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(code)) !== null) {
    const quote = match[1];
    const specifier = match[2];
    if (quote === undefined || specifier === undefined) continue;
    if (!seen.has(specifier)) {
      seen.add(specifier);
      found.push(specifier);
    }
  }
  return found;
}

/** True when the code contains a static import or export statement. */
export function isModuleCode(code: string): boolean {
  return scanModuleSpecifiers(code).length > 0;
}

/**
 * The specifiers in string-literal dynamic imports, `import('x')` and
 * `import("x")`, in first-seen order, deduplicated. These are graph
 * edges exactly like static imports — the worker pre-fetches them, so
 * `import()` at runtime resolves from the pre-fetched map and the
 * guest re-renders with the loaded module. Computed specifiers
 * (`import(name)`, template literals) are NOT collected: they cannot
 * be known ahead of time, so they go through `host.importModule`
 * instead. Comments and string literals are skipped like in
 * scanModuleSpecifiers, so an `import('x')` mentioned in a comment
 * or a string is not treated as a real import.
 */
export function scanDynamicImportSpecifiers(code: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const token =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\bimport\s*\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(code)) !== null) {
    const quote = match[1];
    const specifier = match[2];
    if (quote === undefined || specifier === undefined) continue;
    if (!seen.has(specifier)) {
      seen.add(specifier);
      found.push(specifier);
    }
  }
  return found;
}

/**
 * Resolve one specifier to an absolute http(s) URL.
 *
 * - Bare specifiers ("d3-format") come from the import map; an unmapped
 *   bare specifier is an error naming the specifier.
 * - Absolute http(s) URLs pass through.
 * - Relative specifiers ("./x.mjs", "../y.mjs") resolve against the
 *   importing module's URL; without one (the entry module) they error.
 * Anything else (other schemes, unparseable URLs) errors, fail closed.
 */
export function resolveSpecifier(
  specifier: string,
  base: string | null,
  importMap: ImportMap,
): string {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  ) {
    if (base === null) {
      throw new Error(
        `relative import "${specifier}" is only supported inside fetched modules; ` +
          `map the entry module's imports in the import map`,
      );
    }
    return checkedUrl(new URL(specifier, base).href, specifier);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
    return checkedUrl(specifier, specifier);
  }
  const mapped = importMap[specifier];
  if (mapped === undefined) {
    throw new Error(`unknown import "${specifier}" (not in the import map)`);
  }
  return checkedUrl(mapped, specifier);
}

function checkedUrl(url: string, specifier: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`import "${specifier}" does not resolve to a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`import "${specifier}" must resolve to an http(s) URL`);
  }
  return parsed.href;
}

/**
 * Validate an import map supplied by the host app. Keys must be
 * non-empty strings; values must be absolute http(s) URLs. Returns the
 * map unchanged when valid, throws otherwise.
 */
export function validateImportMap(map: unknown): ImportMap {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw new Error("imports: import map must be an object of specifier -> URL");
  }
  const record = map as Record<string, unknown>;
  const out: ImportMap = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.length === 0) throw new Error("imports: specifier must be a non-empty string");
    if (typeof value !== "string") {
      throw new Error(`imports: URL for "${key}" must be a string`);
    }
    out[key] = checkedUrl(value, key);
  }
  return out;
}

/**
 * Host-side cache of downloaded module sources, keyed by resolved URL.
 * Lives on the Sandbox (not on a session) so a watchdog rebuild neither
 * re-downloads nor re-prompts for modules already imported, and dies on
 * dispose() like the connection grants.
 */
export class ImportCache {
  private readonly sources = new Map<string, string>();

  get(url: string): string | undefined {
    return this.sources.get(url);
  }

  has(url: string): boolean {
    return this.sources.has(url);
  }

  set(url: string, source: string): void {
    this.sources.set(url, source);
  }

  /** Cached URLs, in first-cached order. A copy; mutating it is harmless. */
  keys(): string[] {
    return [...this.sources.keys()];
  }

  get size(): number {
    return this.sources.size;
  }

  clear(): void {
    this.sources.clear();
  }
}
