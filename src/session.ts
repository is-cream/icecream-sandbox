/**
 * Host-side session: one MessagePort, one in-flight run, one ask allowlist.
 *
 * The session knows nothing about iframes or workers. It speaks only JSON
 * strings over the port, validates everything it receives, and owns the
 * host-side watchdog: if a run produces no result within 1.5x its deadline,
 * the run is rejected and the session is marked failed so the owner can
 * terminate the worker and build a fresh session. A failed session is never
 * reused for another run.
 */
import { decodeMessage, encodeMessage } from "./protocol.js";
import {
  DEFAULT_LIMITS,
  resolveLimits,
  type ResolvedLimits,
  type RunLimits,
} from "./limits.js";
import { validateImportMap, type ImportMap } from "./imports.js";
import type { BridgeSpec, JsonValue } from "./bridge.js";

export type AskHandler = (arg: string) => string | Promise<string>;

/** One host implementation behind a bridged global, by dotted path. */
export type BridgeHandler = (path: string, args: JsonValue[]) => Promise<JsonValue>;

export type SessionEvent = "message" | "error";

export interface PortLike {
  postMessage(message: string): void;
  close?(): void;
  // Exactly the DOM MessagePort handler type, so a real MessagePort
  // satisfies this interface with no cast.
  onmessage: MessagePort["onmessage"];
}

/** Watchdog multiplier over the run deadline. Fixed by design, not a knob. */
export const WATCHDOG_MULTIPLIER = 1.5;

export class Session {
  private port: PortLike;
  private readonly maxInboundBytes: number;
  private readonly maxMessageSize: number;
  private readonly expectedNonce: string;
  private messageListeners = new Set<(message: string) => void>();
  private errorListeners = new Set<(error: string) => void>();
  private askHandlers = new Map<string, AskHandler>();
  private runId = 0;
  private invokeId = 0;
  private pendingRun: {
    id: number;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    watchdog: ReturnType<typeof setTimeout>;
  } | null = null;
  private pendingInvokes = new Map<
    number,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >();
  private failed = false;
  private disposed = false;
  /** Called exactly once when the session fails (watchdog, port loss). */
  onFatal: (() => void) | null = null;
  /**
   * Host-side connection handler (the ConnectionGate). When null, every
   * guest connection request is answered with an error — fail closed.
   */
  onConnectionRequest: ((url: string) => Promise<string>) | null = null;
  /**
   * Host-side import handler (Sandbox.importModule: cache, then the same
   * gate). When null, every worker import request is answered with an
   * error — fail closed. Imports never bypass the gate: the handler is
   * what routes them through it.
   */
  onImportRequest: ((url: string) => Promise<string>) | null = null;
  /** Resolved when the worker's ready message arrives with the right nonce. */
  readonly ready: Promise<void>;
  private readyResolve: () => void = () => undefined;
  /**
   * Host-side bridge dispatcher (Sandbox's `globals` config). When
   * null, every guest bridge call is answered with an error — fail
   * closed. The worker only ever sends paths from the configured
   * spec, but the dispatcher looks the path up anyway and never
   * trusts it.
   */
  onBridgeRequest: BridgeHandler | null = null;
  /** Shape-only bridge spec + guest-function allowlist, sent with each run. */
  private readonly bridgeSpec: BridgeSpec;
  private readonly guestFunctions: string[];

  constructor(
    port: PortLike,
    options: {
      maxInboundBytes: number;
      expectedNonce: string;
      maxMessageSize?: number;
      bridgeSpec?: BridgeSpec;
      guestFunctions?: string[];
    },
  ) {
    this.port = port;
    this.maxInboundBytes = options.maxInboundBytes;
    this.maxMessageSize = options.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
    this.expectedNonce = options.expectedNonce;
    this.bridgeSpec = options.bridgeSpec ?? {};
    this.guestFunctions = options.guestFunctions ?? [];
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    port.onmessage = (event) => {
      this.handlePortMessage(event.data);
    };
  }

  on(event: SessionEvent, callback: (value: string) => void): () => void {
    const set = event === "message" ? this.messageListeners : this.errorListeners;
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  /** Register one named ask handler. Names are an explicit allowlist. */
  registerAsk(name: string, handler: AskHandler): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("registerAsk: name must be a non-empty string");
    }
    if (this.askHandlers.has(name)) {
      throw new Error(`registerAsk: handler for "${name}" is already registered`);
    }
    this.askHandlers.set(name, handler);
  }

  run(code: string, limitsInput?: RunLimits, importsInput?: ImportMap): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("session is disposed"));
    if (this.failed) return Promise.reject(new Error("session failed; create a new session"));
    if (this.pendingRun !== null) {
      return Promise.reject(new Error("a run is already in flight on this session"));
    }
    let limits: ResolvedLimits;
    let imports: ImportMap;
    try {
      limits = resolveLimits(limitsInput);
      imports = validateImportMap(importsInput ?? {});
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (typeof code !== "string") {
      return Promise.reject(new Error("run: code must be a string"));
    }
    if (code.length > limits.maxCodeSize) {
      return Promise.reject(new Error("run: code exceeds maxCodeSize"));
    }
    const id = ++this.runId;
    return new Promise<string>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        if (this.pendingRun !== null && this.pendingRun.id === id) {
          this.pendingRun = null;
          reject(
            new Error(
              `watchdog: worker produced no result within ${WATCHDOG_MULTIPLIER}x the deadline; ` +
                `the worker will be terminated and the session rebuilt`,
            ),
          );
          this.fail();
        }
      }, limits.deadlineMs * WATCHDOG_MULTIPLIER);
      this.pendingRun = { id, resolve, reject, watchdog };
      this.port.postMessage(
        encodeMessage({
          t: "run",
          id,
          code,
          limits,
          imports,
          bridge: this.bridgeSpec,
          guestFunctions: this.guestFunctions,
        }),
      );
    });
  }

  /**
   * Call a guest function by dotted path (host -> guest). Only names
   * in the sandbox's `guestFunctions` allowlist resolve; anything
   * else rejects. The guest function receives one string argument and
   * must return a string. The call is bounded by the in-flight run:
   * if the run ends first, the promise rejects.
   */
  invoke(path: string, arg: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("session is disposed"));
    if (this.failed) return Promise.reject(new Error("session failed; create a new session"));
    if (typeof path !== "string" || path.length === 0) {
      return Promise.reject(new Error("invoke: path must be a non-empty string"));
    }
    if (typeof arg !== "string") {
      return Promise.reject(new Error("invoke: arg must be a string"));
    }
    if (this.pendingRun === null) {
      return Promise.reject(new Error("invoke: no run in flight to invoke a guest function on"));
    }
    const id = ++this.invokeId;
    return new Promise<string>((resolve, reject) => {
      this.pendingInvokes.set(id, { resolve, reject });
      this.port.postMessage(encodeMessage({ t: "invoke-guest", id, path, arg }));
    });
  }

  /** Deliver a message to the guest's onMessage, if a run is in flight. */
  send(message: string): void {
    if (this.disposed) throw new Error("session is disposed");
    if (this.failed) throw new Error("session failed; create a new session");
    if (typeof message !== "string") throw new Error("send: message must be a string");
    if (message.length > this.maxMessageSize) {
      throw new Error("send: message exceeds maxMessageSize");
    }
    this.port.postMessage(encodeMessage({ t: "send", message }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingRun !== null) {
      clearTimeout(this.pendingRun.watchdog);
      this.pendingRun.reject(new Error("session disposed"));
      this.pendingRun = null;
    }
    this.rejectInvokes(new Error("session disposed"));
    try {
      this.port.postMessage(encodeMessage({ t: "dispose" }));
    } catch {
      // The port may already be dead; closing below still runs.
    }
    try {
      this.port.close?.();
    } catch {
      // ignore
    }
    this.port.onmessage = null;
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.rejectInvokes(new Error("session failed; create a new session"));
    try {
      this.port.close?.();
    } catch {
      // ignore
    }
    this.port.onmessage = null;
    const fatal = this.onFatal;
    if (fatal !== null) fatal();
  }

  private handlePortMessage(raw: unknown): void {
    const message = decodeMessage(raw, this.maxInboundBytes);
    if (message === null) return; // malformed: ignored, fail closed
    switch (message.t) {
      case "ready":
        if (message.nonce === this.expectedNonce) this.readyResolve();
        return;
      case "result":
      case "error": {
        if (this.pendingRun !== null && this.pendingRun.id === message.id) {
          const pending = this.pendingRun;
          this.pendingRun = null;
          clearTimeout(pending.watchdog);
          if (message.t === "result") pending.resolve(message.value);
          else pending.reject(new Error(message.error));
          this.rejectInvokes(
            new Error("the run ended before the guest answered the invocation"),
          );
        }
        return;
      }
      case "message":
        for (const listener of this.messageListeners) listener(message.message);
        return;
      case "guest-error":
        for (const listener of this.errorListeners) listener(message.error);
        return;
      case "ask": {
        void this.answerAsk(message.id, message.name, message.arg);
        return;
      }
      case "connection-request": {
        void this.answerConnection(message.id, message.url);
        return;
      }
      case "import-request": {
        void this.answerImport(message.id, message.url);
        return;
      }
      case "bridge-call": {
        void this.answerBridge(message.id, message.path, message.args);
        return;
      }
      case "invoke-result": {
        const pending = this.pendingInvokes.get(message.id);
        if (pending !== undefined) {
          this.pendingInvokes.delete(message.id);
          pending.resolve(message.value);
        }
        return;
      }
      case "invoke-error": {
        const pending = this.pendingInvokes.get(message.id);
        if (pending !== undefined) {
          this.pendingInvokes.delete(message.id);
          pending.reject(new Error(message.error));
        }
        return;
      }
    }
  }

  private rejectInvokes(error: Error): void {
    if (this.pendingInvokes.size === 0) return;
    const pending = Array.from(this.pendingInvokes.values());
    this.pendingInvokes.clear();
    for (const entry of pending) entry.reject(error);
  }

  /**
   * Answer one guest call of a bridged global. The path is looked up
   * in the host's own config (own properties only) and the arguments
   * arrive as JSON; the implementation's return value must be
   * JSON-serializable. A host function returning undefined resolves
   * the guest's await with null.
   */
  private async answerBridge(id: number, path: string, argsJson: string): Promise<void> {
    if (this.onBridgeRequest === null) {
      this.post({ t: "bridge-error", id, error: "bridged globals are not enabled" });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (!Array.isArray(parsed)) {
        throw new Error("bridge call arguments must be a JSON array");
      }
      const value = await this.onBridgeRequest(path, parsed as JsonValue[]);
      const json = JSON.stringify(value);
      this.post({
        t: "bridge-result",
        id,
        value: json === undefined ? "null" : json,
      });
    } catch (error) {
      this.post({
        t: "bridge-error",
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async answerImport(id: number, url: string): Promise<void> {
    if (this.onImportRequest === null) {
      this.post({ t: "import-error", id, error: "imports are not enabled" });
      return;
    }
    try {
      const value = await this.onImportRequest(url);
      if (typeof value !== "string") {
        this.post({ t: "import-error", id, error: "import handler returned a non-string" });
        return;
      }
      if (value.length > this.maxInboundBytes) {
        // Same backstop as connections: a module source must fit the port.
        // The gate's maxResponseBytes is the operative limit; this only
        // catches a handler that ignored it.
        this.post({ t: "import-error", id, error: "import response exceeds maxInboundBytes" });
        return;
      }
      this.post({ t: "import-result", id, value });
    } catch (error) {
      this.post({
        t: "import-error",
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async answerConnection(id: number, url: string): Promise<void> {
    if (this.onConnectionRequest === null) {
      this.post({ t: "connection-error", id, error: "connections are not enabled" });
      return;
    }
    try {
      const value = await this.onConnectionRequest(url);
      if (typeof value !== "string") {
        this.post({ t: "connection-error", id, error: "connection handler returned a non-string" });
        return;
      }
      if (value.length > this.maxInboundBytes) {
        // The gate's own response cap should have caught this first; this
        // is the backstop so an oversized body can never cross the port.
        // Note this is the port's inbound cap, not maxMessageSize: a
        // connection body (a stylesheet, for example) is legitimately
        // larger than a chat message, and the gate's maxResponseBytes is
        // the operative limit.
        this.post({ t: "connection-error", id, error: "connection response exceeds maxInboundBytes" });
        return;
      }
      this.post({ t: "connection-result", id, value });
    } catch (error) {
      this.post({
        t: "connection-error",
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async answerAsk(id: number, name: string, arg: string): Promise<void> {
    const handler = this.askHandlers.get(name);
    if (handler === undefined) {
      this.post({ t: "ask-error", id, error: `ask not registered: ${name}` });
      return;
    }
    try {
      const value = await handler(arg);
      if (typeof value !== "string") {
        this.post({ t: "ask-error", id, error: `ask handler for "${name}" returned a non-string` });
        return;
      }
      if (value.length > this.maxMessageSize) {
        this.post({ t: "ask-error", id, error: `ask handler for "${name}" exceeded maxMessageSize` });
        return;
      }
      this.post({ t: "ask-result", id, value });
    } catch (error) {
      this.post({
        t: "ask-error",
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private post(
    message:
      | { t: "ask-result"; id: number; value: string }
      | { t: "ask-error"; id: number; error: string }
      | { t: "connection-result"; id: number; value: string }
      | { t: "connection-error"; id: number; error: string }
      | { t: "import-result"; id: number; value: string }
      | { t: "import-error"; id: number; error: string }
      | { t: "bridge-result"; id: number; value: string }
      | { t: "bridge-error"; id: number; error: string },
  ): void {
    if (this.disposed || this.failed) return;
    try {
      this.port.postMessage(encodeMessage(message));
    } catch {
      // The port died; the watchdog or a later run surfaces the failure.
    }
  }
}
