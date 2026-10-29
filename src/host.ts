/**
 * Host-side Sandbox: the public entry point.
 *
 * The host page creates an <iframe sandbox="allow-scripts"> — never
 * allow-same-origin — pointed at an iframe document the integrator serves
 * with the restrictive CSP and Permissions-Policy documented in the README.
 * The host then transfers one end of a MessageChannel to the iframe, which
 * transfers it on to a Web Worker running the embedded QuickJS build. After
 * the handshake, all traffic flows over that port; the host page never talks
 * to the worker directly.
 *
 * The iframe's origin is "null", so the handshake is verified with a random
 * nonce and event.source checks, not with origin. Messages from any other
 * source are ignored.
 *
 * If the watchdog fires (or the session otherwise fails), the host tells the
 * iframe to terminate the worker and the next run() rebuilds a fresh session
 * over a fresh channel and worker. A failed session is never reused.
 */
import { Session, type AskHandler, type BridgeHandler, type SessionEvent } from "./session.js";
import { DEFAULT_LIMITS, type RunLimits } from "./limits.js";
import {
  ConnectionGate,
  type ConnectionApprovalHandler,
} from "./connections.js";
import { ImportCache, type ImportMap } from "./imports.js";
import {
  normalizeBridgeGlobals,
  validateGuestFunctions,
  type BridgeFunction,
  type BridgeGlobals,
  type BridgeSpec,
  type JsonValue,
} from "./bridge.js";

export interface SandboxOptions {
  /** URL of the served iframe document (dist/iframe.html). Required. */
  iframeUrl: string;
  /** Document to create the iframe in. Defaults to the global document. */
  document?: Document;
  /** Default limits applied to runs that do not pass their own. */
  defaultLimits?: RunLimits;
  /** Max inbound bytes for one port message. Default: max(64 KiB, maxCodeSize). */
  maxInboundBytes?: number;
  /** How long to wait for iframe load + worker ready. Default 10000 ms. */
  handshakeTimeoutMs?: number;
  /**
   * Origins the app pre-approves for guest connections, e.g.
   * ["https://cdn.jsdelivr.net"]. Held host-side; the guest can neither
   * read nor change this list. Default: none pre-approved.
   */
  allowedOrigins?: string[];
  /**
   * Human-in-the-loop approval callback for guest connection requests
   * whose origin is neither pre-approved nor session-granted. It runs in
   * the host page (your UI) and answers "allow-once", "allow-session", or
   * "deny". Absent means deny. See connections.ts.
   */
  onConnectionRequest?: ConnectionApprovalHandler;
  /**
   * Max response body bytes returned to the guest per connection.
   * Default 1 MiB. Note a response must also fit maxInboundBytes to cross
   * the port; with defaults both are 1 MiB.
   */
  maxConnectionResponseBytes?: number;
  /** Per-connection timeout in milliseconds. Default 10000. */
  connectionTimeoutMs?: number;
  /**
   * Transparent globals the guest may call like normal APIs —
   * alert("hi"), localStorage.setItem("k", "v") — without knowing any
   * sandbox-specific `host.` object. Each function here becomes a
   * global in the guest realm; each call crosses to the host, which
   * runs this implementation and returns the result. Nested objects
   * become namespaces (e.g. `localStorage: { getItem, setItem }`).
   * A name not listed here simply does not exist in the guest realm
   * (ReferenceError, fail closed). Calls are async by physics — the
   * guest always gets a promise back, so LLM-generated code should
   * await them. See bridge.ts.
   */
  globals?: BridgeGlobals;
  /**
   * Allowlist of guest globals the host may call with
   * sandbox.invoke("a.b.c", arg) — dotted paths into plain guest
   * functions or methods on guest objects. The guest defines them
   * normally; no registration call is needed on the guest side, and
   * the guest cannot expand this list. Default: none.
   */
  guestFunctions?: string[];
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;

function randomNonce(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoObject !== undefined && typeof cryptoObject.getRandomValues === "function") {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Sandbox {
  private readonly options: SandboxOptions;
  private readonly doc: Document;
  private readonly gate: ConnectionGate;
  /**
   * Downloaded module sources, keyed by resolved URL. Lives on the
   * Sandbox (not on a session) for the same reason grants do: a
   * watchdog rebuild must neither re-download nor re-prompt for a
   * module already imported. Cleared on dispose().
   */
  private readonly importCache = new ImportCache();
  private iframe: HTMLIFrameElement | null = null;
  private session: Session | null = null;
  private nonce = "";
  private sessionFailed = false;
  private disposed = false;
  private creating: Promise<void> | null = null;
  private messageListeners = new Set<(message: string) => void>();
  private errorListeners = new Set<(error: string) => void>();
  private askHandlers = new Map<string, AskHandler>();
  /** Shape-only spec of the configured globals (worker never sees host code). */
  private readonly bridgeSpec: BridgeSpec;
  /** Dotted paths the host may invoke on the guest. */
  private readonly guestFunctions: string[];

  private constructor(
    options: SandboxOptions,
    doc: Document,
    bridgeSpec: BridgeSpec,
    guestFunctions: string[],
  ) {
    this.options = options;
    this.doc = doc;
    this.bridgeSpec = bridgeSpec;
    this.guestFunctions = guestFunctions;
    // The gate lives on the Sandbox, not on a session: session grants
    // survive worker rebuilds (a watchdog kill must not re-prompt the
    // user for an origin they already approved), and die on dispose().
    this.gate = new ConnectionGate({
      allowedOrigins: options.allowedOrigins,
      onRequest: options.onConnectionRequest,
      maxResponseBytes: options.maxConnectionResponseBytes,
      timeoutMs: options.connectionTimeoutMs,
    });
  }

  /**
   * Build the iframe, run the handshake, and resolve once the worker's
   * ready message arrives with the expected nonce.
   */
  static async create(options: SandboxOptions): Promise<Sandbox> {
    if (typeof options.iframeUrl !== "string" || options.iframeUrl.length === 0) {
      throw new Error("create: iframeUrl is required (serve dist/iframe.html and pass its URL)");
    }
    const doc = options.document ?? globalThis.document;
    // Validate the bridge config now: a bad mapping must fail at
    // create time, never mid-run inside the sandbox.
    const bridgeSpec = normalizeBridgeGlobals(options.globals);
    const guestFunctions = validateGuestFunctions(options.guestFunctions);
    const sandbox = new Sandbox(options, doc, bridgeSpec, guestFunctions);
    await sandbox.buildSession();
    return sandbox;
  }

  /**
   * Run guest code. When the code uses static imports, `imports` is the
   * import map (bare specifier -> absolute module URL, pinned version).
   * Every module is downloaded through the connection gate (one
   * human-in-the-loop approval per origin, then session grants) and
   * cached here, so a second run importing the same URL downloads
   * nothing and prompts nobody. See imports.ts.
   */
  run(code: string, limits?: RunLimits, imports?: ImportMap): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("sandbox is disposed"));
    return this.withSession(async (session) =>
      session.run(code, this.mergeLimits(limits), imports),
    );
  }

  /**
   * Download one module source: cache hit returns immediately, otherwise
   * the connection gate fetches it (allowlist, session grant, or a
   * human-in-the-loop approval) and the result is cached. Imported code
   * runs inside the guest realm with guest limits — downloading never
   * grants it anything the guest does not already have.
   */
  async importModule(url: string): Promise<string> {
    const cached = this.importCache.get(url);
    if (cached !== undefined) return cached;
    const source = await this.gate.fetchText(url);
    this.importCache.set(url, source);
    return source;
  }

  /** URLs of cached module sources, in first-cached order. A copy. */
  getImportCache(): string[] {
    return this.importCache.keys();
  }

  /** Drop all cached module sources. The next import re-downloads. */
  clearImportCache(): void {
    this.importCache.clear();
  }

  send(message: string): void {
    if (this.disposed) throw new Error("sandbox is disposed");
    if (this.session === null || this.sessionFailed) {
      throw new Error("sandbox has no live session; call run() first to rebuild it");
    }
    this.session.send(message);
  }

  /**
   * Call a guest function by dotted path — host -> guest. The guest
   * just defines a normal global (`function render(d) {...}` or
   * `const app = { render(d) {...} }`); no guest-side registration
   * call is needed. Only paths in the create-time `guestFunctions`
   * allowlist resolve; the path walks own properties only, the final
   * value must be a function, and it is called with its parent object
   * as `this`. The guest function receives one string argument and
   * must return a string (sync or async — an async one is bounded by
   * the in-flight run's deadline).
   */
  invoke(name: string, arg = ""): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("sandbox is disposed"));
    return this.withSession(async (session) => session.invoke(name, arg));
  }

  on(event: SessionEvent, callback: (value: string) => void): () => void {
    // Listeners live on the Sandbox, not on the session: sessions are
    // rebuilt after failures, and a listener must survive a rebuild and
    // must actually stop when unsubscribed. Each session forwards into
    // these sets (see buildSession).
    const set = event === "message" ? this.messageListeners : this.errorListeners;
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  registerAsk(name: string, handler: AskHandler): void {
    if (this.askHandlers.has(name)) {
      throw new Error(`registerAsk: handler for "${name}" is already registered`);
    }
    this.askHandlers.set(name, handler);
    if (this.session !== null && !this.sessionFailed) {
      this.session.registerAsk(name, handler);
    }
  }

  /** Origins the user granted this session (a copy). */
  getConnectionGrants(): string[] {
    return this.gate.getGrants();
  }

  /** Revoke one session grant. Returns true when a grant was removed. */
  revokeConnectionGrant(origin: string): boolean {
    return this.gate.revokeGrant(origin);
  }

  /** Revoke all session grants. */
  clearConnectionGrants(): void {
    this.gate.clearGrants();
  }

  /** Terminate the worker, close the port, and remove the iframe. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gate.clearGrants();
    this.importCache.clear();
    this.terminateWorker();
    if (this.session !== null) {
      this.session.dispose();
      this.session = null;
    }
    if (this.iframe !== null) {
      this.iframe.remove();
      this.iframe = null;
    }
  }

  // ------------------------------------------------------------- internals ---

  /**
   * Dispatch one guest call of a bridged global into the host's
   * `globals` config. The path is looked up through own properties
   * only — the worker only ever sends configured paths, but the
   * dispatcher never trusts that.
   */
  private makeBridgeDispatcher(): BridgeHandler {
    const globals: Record<string, unknown> = (this.options.globals ?? {}) as Record<
      string,
      unknown
    >;
    return async (path: string, args: JsonValue[]): Promise<JsonValue> => {
      let node: unknown = globals;
      for (const segment of path.split(".")) {
        if (
          typeof node !== "object" ||
          node === null ||
          !Object.prototype.hasOwnProperty.call(node, segment)
        ) {
          throw new Error(`bridge call "${path}" is not configured`);
        }
        node = (node as Record<string, unknown>)[segment];
      }
      if (typeof node !== "function") {
        throw new Error(`bridge call "${path}" is not configured`);
      }
      return (node as BridgeFunction)(...args);
    };
  }

  private mergeLimits(limits?: RunLimits): RunLimits {
    return { ...this.options.defaultLimits, ...limits };
  }

  private async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    if (this.session === null || this.sessionFailed) {
      if (this.creating === null) {
        this.creating = this.buildSession().finally(() => {
          this.creating = null;
        });
      }
      await this.creating;
    }
    if (this.session === null) throw new Error("sandbox session could not be built");
    return fn(this.session);
  }

  private async buildSession(): Promise<void> {
    if (this.iframe === null) {
      this.iframe = this.doc.createElement("iframe");
      // allow-scripts ONLY. Never add allow-same-origin: it would let the
      // guest document reach the host origin's storage and cookies.
      this.iframe.setAttribute("sandbox", "allow-scripts");
      this.iframe.setAttribute("aria-hidden", "true");
      this.iframe.setAttribute("tabindex", "-1");
      this.iframe.style.position = "absolute";
      this.iframe.style.width = "1px";
      this.iframe.style.height = "1px";
      this.iframe.style.border = "0";
      this.iframe.src = this.options.iframeUrl;
      this.doc.body.appendChild(this.iframe);
      await this.waitForLoad(this.iframe);
    }
    if (this.session !== null) {
      this.session.dispose();
      this.session = null;
    }
    this.sessionFailed = false;
    this.nonce = randomNonce();
    const channel = new MessageChannel();
    const maxInbound =
      this.options.maxInboundBytes ??
      Math.max(DEFAULT_LIMITS.maxMessageSize, DEFAULT_LIMITS.maxCodeSize);
    const session = new Session(channel.port1, {
      maxInboundBytes: maxInbound,
      expectedNonce: this.nonce,
      maxMessageSize: this.options.defaultLimits?.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize,
      bridgeSpec: this.bridgeSpec,
      guestFunctions: this.guestFunctions,
    });
    session.onFatal = () => {
      this.sessionFailed = true;
      // Kill the hung worker now; the session itself is rebuilt lazily on
      // the next run() so a transient failure costs one round trip, not a
      // permanently dead sandbox.
      this.terminateWorker();
    };
    // Bridged-global calls dispatch into the host's `globals` config
    // (bridge.ts). The dispatcher lives on the Sandbox so it survives
    // session rebuilds, like the connection gate.
    session.onBridgeRequest = this.makeBridgeDispatcher();
    // Connection requests route to the gate, which lives on the Sandbox so
    // grants survive this session's rebuilds.
    session.onConnectionRequest = (url) => this.gate.fetchText(url);
    // Import requests route through the same gate via the import cache,
    // so downloads inherit every gate protection (and its approvals).
    session.onImportRequest = (url) => this.importModule(url);
    session.on("message", (message) => {
      for (const listener of this.messageListeners) listener(message);
    });
    session.on("error", (error) => {
      for (const listener of this.errorListeners) listener(error);
    });
    for (const [name, handler] of this.askHandlers) session.registerAsk(name, handler);
    this.session = session;
    const target = this.iframe.contentWindow;
    if (target === null) throw new Error("iframe has no contentWindow");
    target.postMessage({ type: "sandbox-handshake", nonce: this.nonce }, "*", [channel.port2]);
    await this.withTimeout(
      session.ready,
      this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      "handshake timed out waiting for the worker ready message",
    );
  }

  private terminateWorker(): void {
    if (this.iframe === null) return;
    const target = this.iframe.contentWindow;
    if (target === null) return;
    try {
      target.postMessage({ type: "sandbox-watchdog", nonce: this.nonce }, "*");
    } catch {
      // The iframe may already be gone; removal below still cleans up.
    }
  }

  private waitForLoad(iframe: HTMLIFrameElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("iframe load timed out"));
      }, this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
      const onLoad = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("iframe failed to load"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        iframe.removeEventListener("load", onLoad);
        iframe.removeEventListener("error", onError);
      };
      iframe.addEventListener("load", onLoad);
      iframe.addEventListener("error", onError);
    });
  }

  private async withTimeout(promise: Promise<void>, ms: number, message: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export { DEFAULT_LIMITS };
export type { RunLimits };
export type {
  ConnectionApprovalHandler,
  ConnectionApprovalRequest,
  ConnectionDecision,
} from "./connections.js";
export type {
  BridgeFunction,
  BridgeGlobals,
  BridgeObject,
  JsonValue,
} from "./bridge.js";
