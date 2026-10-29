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
import { Session, type AskHandler, type SessionEvent } from "./session.js";
import { DEFAULT_LIMITS, type RunLimits } from "./limits.js";
import {
  ConnectionGate,
  type ConnectionApprovalHandler,
} from "./connections.js";

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
  private iframe: HTMLIFrameElement | null = null;
  private session: Session | null = null;
  private nonce = "";
  private sessionFailed = false;
  private disposed = false;
  private creating: Promise<void> | null = null;
  private messageListeners = new Set<(message: string) => void>();
  private errorListeners = new Set<(error: string) => void>();
  private askHandlers = new Map<string, AskHandler>();

  private constructor(options: SandboxOptions, doc: Document) {
    this.options = options;
    this.doc = doc;
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
    const sandbox = new Sandbox(options, doc);
    await sandbox.buildSession();
    return sandbox;
  }

  run(code: string, limits?: RunLimits): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("sandbox is disposed"));
    return this.withSession(async (session) => session.run(code, this.mergeLimits(limits)));
  }

  send(message: string): void {
    if (this.disposed) throw new Error("sandbox is disposed");
    if (this.session === null || this.sessionFailed) {
      throw new Error("sandbox has no live session; call run() first to rebuild it");
    }
    this.session.send(message);
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
    });
    session.onFatal = () => {
      this.sessionFailed = true;
      // Kill the hung worker now; the session itself is rebuilt lazily on
      // the next run() so a transient failure costs one round trip, not a
      // permanently dead sandbox.
      this.terminateWorker();
    };
    // Connection requests route to the gate, which lives on the Sandbox so
    // grants survive this session's rebuilds.
    session.onConnectionRequest = (url) => this.gate.fetchText(url);
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
