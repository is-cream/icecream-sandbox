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

export type AskHandler = (arg: string) => string | Promise<string>;

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
  private pendingRun: {
    id: number;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    watchdog: ReturnType<typeof setTimeout>;
  } | null = null;
  private failed = false;
  private disposed = false;
  /** Called exactly once when the session fails (watchdog, port loss). */
  onFatal: (() => void) | null = null;
  /**
   * Host-side connection handler (the ConnectionGate). When null, every
   * guest connection request is answered with an error — fail closed.
   */
  onConnectionRequest: ((url: string) => Promise<string>) | null = null;
  /** Resolved when the worker's ready message arrives with the right nonce. */
  readonly ready: Promise<void>;
  private readyResolve: () => void = () => undefined;

  constructor(
    port: PortLike,
    options: { maxInboundBytes: number; expectedNonce: string; maxMessageSize?: number },
  ) {
    this.port = port;
    this.maxInboundBytes = options.maxInboundBytes;
    this.maxMessageSize = options.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
    this.expectedNonce = options.expectedNonce;
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

  run(code: string, limitsInput?: RunLimits): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("session is disposed"));
    if (this.failed) return Promise.reject(new Error("session failed; create a new session"));
    if (this.pendingRun !== null) {
      return Promise.reject(new Error("a run is already in flight on this session"));
    }
    let limits: ResolvedLimits;
    try {
      limits = resolveLimits(limitsInput);
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
      this.port.postMessage(encodeMessage({ t: "run", id, code, limits }));
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
      | { t: "connection-error"; id: number; error: string },
  ): void {
    if (this.disposed || this.failed) return;
    try {
      this.port.postMessage(encodeMessage(message));
    } catch {
      // The port died; the watchdog or a later run surfaces the failure.
    }
  }
}
