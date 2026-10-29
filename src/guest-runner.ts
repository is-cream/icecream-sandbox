/**
 * Worker-side guest runner: the only code that ever touches QuickJS.
 *
 * One run = one fresh QuickJS runtime + context, disposed when the run
 * settles for any reason. A runtime is never reused after an error — least
 * of all after an out-of-memory error, where the heap may be corrupt.
 *
 * The guest sees exactly one global besides the standard intrinsics: `host`,
 * with `host.send(string)`, `host.ask(name, arg?) -> Promise<string>`, and
 * `host.fetchText(url) -> Promise<string>` (a gated host-side fetch — see
 * connections.ts; the guest itself has no network capability).
 * Everything else — fetch, XHR, WebSocket, timers, process, require, DOM —
 * simply does not exist in a QuickJS context, because nothing puts it there.
 *
 * This module is deliberately free of DOM and Worker globals (apart from
 * setTimeout, used only to yield the pump loop) so it can be unit-tested
 * directly in Node.
 */
import {
  newQuickJSWASMModuleFromVariant,
  Scope,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  decodeMessage,
  encodeMessage,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from "./protocol.js";
import type { ResolvedLimits } from "./limits.js";

const ERROR_TEXT_CAP = 4096;

function truncate(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + "…(truncated)" : text;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return truncate(error.message || error.name, ERROR_TEXT_CAP);
  return truncate(String(error), ERROR_TEXT_CAP);
}

interface ActiveRun {
  id: number;
  runtime: QuickJSRuntime;
  context: QuickJSContext;
  limits: ResolvedLimits;
  deadlineAt: number;
  outputBytes: number;
  pendingAsks: Map<number, QuickJSDeferredPromise>;
  pendingFetches: Map<number, QuickJSDeferredPromise>;
  wakeResolvers: Array<() => void>;
  /**
   * True once the pump loop's finally has run (and disposed the completion
   * handle). The runtime must not be freed before that: the completion
   * handle keeps the guest promise alive, and freeing the runtime first
   * trips QuickJS's "gc object list not empty" assertion.
   */
  pumpExited: boolean;
  resourcesDisposed: boolean;
}

export class GuestRunner {
  private module: QuickJSWASMModule;
  private sendRaw: (raw: string) => void;
  private active: ActiveRun | null = null;
  private nextAskId = 1;
  private nextFetchId = 1;
  private runsCompleted = 0;
  private disposed = false;
  private readonly textEncoder = new TextEncoder();

  private constructor(module: QuickJSWASMModule, sendRaw: (raw: string) => void) {
    this.module = module;
    this.sendRaw = sendRaw;
  }

  /**
   * Load the embedded singlefile QuickJS build. This performs no fetch: the
   * WebAssembly is base64-embedded in the variant module itself.
   */
  static async create(sendRaw: (raw: string) => void): Promise<GuestRunner> {
    const module = await newQuickJSWASMModuleFromVariant(variant);
    return new GuestRunner(module, sendRaw);
  }

  stats(): {
    runsCompleted: number;
    activeRun: boolean;
    pendingAsks: number;
    pendingFetches: number;
  } {
    return {
      runsCompleted: this.runsCompleted,
      activeRun: this.active !== null,
      pendingAsks: this.active ? this.active.pendingAsks.size : 0,
      pendingFetches: this.active ? this.active.pendingFetches.size : 0,
    };
  }

  /** Handle one raw message from the host port. Malformed input is ignored. */
  handleMessage(raw: unknown): void {
    if (this.disposed) return;
    const message = decodeMessage(raw, 8 * 1024 * 1024);
    if (message === null) return;
    switch (message.t) {
      case "run":
        void this.startRun(message.id, message.code, message.limits);
        return;
      case "send":
        this.deliver(message.message);
        return;
      case "ask-result":
        this.settleAsk(message.id, true, message.value);
        return;
      case "ask-error":
        this.settleAsk(message.id, false, message.error);
        return;
      case "connection-result":
        this.settleFetch(message.id, true, message.value);
        return;
      case "connection-error":
        this.settleFetch(message.id, false, message.error);
        return;
      case "dispose":
        this.dispose();
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active !== null) {
      this.abortActiveRun("runner disposed");
    }
    // The module itself has no dispose in quickjs-emscripten-core: it lives
    // for the worker's lifetime, and the worker is the disposal boundary
    // (the iframe terminates it). All per-run state is disposed above.
  }

  // ---------------------------------------------------------------- run ---

  private async startRun(id: number, code: string, limits: ResolvedLimits): Promise<void> {
    if (this.active !== null) {
      this.reply({ t: "error", id, error: "a run is already active in this worker" });
      return;
    }
    if (code.length > limits.maxCodeSize) {
      this.reply({ t: "error", id, error: "guest code exceeds maxCodeSize" });
      return;
    }
    const runtime = this.module.newRuntime();
    const run: ActiveRun = {
      id,
      runtime,
      context: runtime.newContext(),
      limits,
      deadlineAt: Date.now() + limits.deadlineMs,
      outputBytes: 0,
      pendingAsks: new Map(),
      pendingFetches: new Map(),
      wakeResolvers: [],
      pumpExited: false,
      resourcesDisposed: false,
    };
    this.active = run;
    try {
      runtime.setMemoryLimit(limits.memoryLimitBytes);
      runtime.setMaxStackSize(limits.maxStackSize);
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(run.deadlineAt));
      this.installHost(run);
      const result = await this.evalAndPump(run, code);
      this.accountOutput(run, result);
      this.reply({ t: "result", id, value: result });
    } catch (error) {
      this.reply({ t: "error", id, error: errorText(error) });
    } finally {
      this.teardownRun(run);
    }
  }

  private teardownRun(run: ActiveRun): void {
    // Reject anything still outstanding so no deferred survives the run.
    this.rejectPending(run, run.pendingAsks);
    this.rejectPending(run, run.pendingFetches);
    run.pendingAsks.clear();
    run.pendingFetches.clear();
    // Clear active FIRST and wake the pump loop, so it sees the run is
    // gone and throws "run aborted" instead of touching a disposed runtime.
    if (this.active === run) this.active = null;
    this.wake(run);
    // Dispose the runtime only if the pump loop has already exited (its
    // finally disposes the completion handle first). When teardown runs
    // while the loop is still parked — watchdog kill, runner dispose — the
    // loop's finally performs the disposal on its way out; freeing the
    // runtime here would leave the completion handle alive and trip
    // QuickJS's gc-list assertion. The runtime is never reused, whatever
    // happened.
    if (run.pumpExited) this.disposeRunResources(run);
  }

  private rejectPending(
    run: ActiveRun,
    pending: Map<number, QuickJSDeferredPromise>,
  ): void {
    for (const deferred of pending.values()) {
      const reason = run.context.newString("run ended before the host answered");
      try {
        deferred.reject(reason);
      } catch {
        // The runtime may already be unusable; disposal below still runs.
      } finally {
        // The reject call borrows the handle; it must be disposed here.
        try {
          reason.dispose();
        } catch {
          // ignore
        }
      }
      try {
        deferred.dispose();
      } catch {
        // ignore
      }
    }
  }

  /** Free a run's context and runtime. Idempotent; runs exactly once. */
  private disposeRunResources(run: ActiveRun): void {
    if (run.resourcesDisposed) return;
    run.resourcesDisposed = true;
    try {
      run.context.dispose();
    } catch {
      // ignore
    }
    try {
      run.runtime.dispose();
    } catch {
      // ignore
    }
    this.runsCompleted += 1;
  }

  private abortActiveRun(reason: string): void {
    const run = this.active;
    if (run === null) return;
    this.reply({ t: "error", id: run.id, error: reason });
    this.teardownRun(run);
  }

  private installHost(run: ActiveRun): void {
    const vm = run.context;
    Scope.withScope((scope) => {
      const host = scope.manage(vm.newObject());
      // setProp returns void, so it is not a managed lifetime — only the
      // handles passed to it are.
      vm.setProp(
        host,
        "send",
        scope.manage(
          vm.newFunction("send", (arg) => {
            this.guestSend(run, arg);
          }),
        ),
      );
      vm.setProp(
        host,
        "ask",
        scope.manage(
          vm.newFunction("ask", (nameArg, argArg) => {
            return this.guestAsk(run, nameArg, argArg);
          }),
        ),
      );
      vm.setProp(
        host,
        "fetchText",
        scope.manage(
          vm.newFunction("fetchText", (urlArg) => {
            return this.guestFetchText(run, urlArg);
          }),
        ),
      );
      vm.setProp(vm.global, "host", host);
    });
  }

  // ------------------------------------------------------- guest calls ---

  private guestSend(run: ActiveRun, arg: QuickJSHandle): void {
    const vm = run.context;
    if (vm.typeof(arg) !== "string") {
      throw new Error("host.send: argument must be a string");
    }
    const message = vm.getString(arg);
    if (message.length > run.limits.maxMessageSize) {
      throw new Error("host.send: message exceeds maxMessageSize");
    }
    this.accountOutput(run, message);
    this.reply({ t: "message", message });
  }

  private guestAsk(
    run: ActiveRun,
    nameArg: QuickJSHandle,
    argArg: QuickJSHandle | undefined,
  ): QuickJSHandle {
    const vm = run.context;
    if (vm.typeof(nameArg) !== "string") {
      throw new Error("host.ask: name must be a string");
    }
    const name = vm.getString(nameArg);
    let arg = "";
    if (argArg !== undefined && argArg !== vm.undefined) {
      if (vm.typeof(argArg) !== "string") {
        throw new Error("host.ask: argument must be a string");
      }
      arg = vm.getString(argArg);
    }
    if (arg.length > run.limits.maxMessageSize) {
      throw new Error("host.ask: argument exceeds maxMessageSize");
    }
    if (run.pendingAsks.size >= run.limits.maxOutstandingAsks) {
      throw new Error("host.ask: too many outstanding asks");
    }
    const deferred = vm.newPromise();
    const askId = this.nextAskId;
    this.nextAskId += 1;
    run.pendingAsks.set(askId, deferred);
    this.accountOutput(run, arg);
    this.reply({ t: "ask", id: askId, name, arg });
    return deferred.handle;
  }

  /**
   * Request a host-side fetch. This is a REQUEST, not a capability: the
   * host's connection gate decides (allowlist, session grant, or a
   * human-in-the-loop approval) and performs the fetch itself. The guest
   * only ever sees the returned body text, never headers or credentials.
   */
  private guestFetchText(run: ActiveRun, urlArg: QuickJSHandle): QuickJSHandle {
    const vm = run.context;
    if (vm.typeof(urlArg) !== "string") {
      throw new Error("host.fetchText: url must be a string");
    }
    const url = vm.getString(urlArg);
    if (url.length > run.limits.maxMessageSize) {
      throw new Error("host.fetchText: url exceeds maxMessageSize");
    }
    if (run.pendingFetches.size >= run.limits.maxOutstandingFetches) {
      throw new Error("host.fetchText: too many outstanding fetches");
    }
    const deferred = vm.newPromise();
    const fetchId = this.nextFetchId;
    this.nextFetchId += 1;
    run.pendingFetches.set(fetchId, deferred);
    this.accountOutput(run, url);
    this.reply({ t: "connection-request", id: fetchId, url });
    return deferred.handle;
  }

  private settleFetch(fetchId: number, ok: boolean, value: string): void {
    const run = this.active;
    if (run === null) return;
    const deferred = run.pendingFetches.get(fetchId);
    if (deferred === undefined) return;
    run.pendingFetches.delete(fetchId);
    const vm = run.context;
    try {
      const handle = vm.newString(value);
      try {
        if (ok) deferred.resolve(handle);
        else deferred.reject(handle);
      } finally {
        handle.dispose();
      }
    } catch {
      // The runtime may be mid-teardown; the pump loop will surface it.
    } finally {
      try {
        deferred.dispose();
      } catch {
        // ignore
      }
    }
    this.wake(run);
  }

  private settleAsk(askId: number, ok: boolean, value: string): void {
    const run = this.active;
    if (run === null) return;
    const deferred = run.pendingAsks.get(askId);
    if (deferred === undefined) return;
    run.pendingAsks.delete(askId);
    const vm = run.context;
    try {
      if (ok) {
        const handle = vm.newString(value);
        try {
          deferred.resolve(handle);
        } finally {
          handle.dispose();
        }
      } else {
        const handle = vm.newString(value);
        try {
          deferred.reject(handle);
        } finally {
          handle.dispose();
        }
      }
    } catch {
      // The runtime may be mid-teardown; the pump loop will surface it.
    } finally {
      try {
        deferred.dispose();
      } catch {
        // ignore
      }
    }
    this.wake(run);
  }

  private deliver(message: string): void {
    const run = this.active;
    if (run === null) {
      this.reply({ t: "guest-error", error: "no active run to deliver a message to" });
      return;
    }
    const vm = run.context;
    try {
      const handler = vm.getProp(vm.global, "onMessage");
      try {
        if (vm.typeof(handler) !== "function") {
          this.reply({ t: "guest-error", error: "guest has no onMessage function" });
          return;
        }
        const arg = vm.newString(message);
        try {
          const call = vm.callFunction(handler, vm.undefined, arg);
          if (call.error) {
            const text = this.renderError(vm, call.error);
            call.error.dispose();
            this.reply({
              t: "guest-error",
              error: `onMessage threw: ${text}`,
            });
            return;
          }
          call.value.dispose();
        } finally {
          arg.dispose();
        }
      } finally {
        handler.dispose();
      }
    } catch (error) {
      this.reply({ t: "guest-error", error: errorText(error) });
      return;
    }
    // The handler may have queued promise jobs; wake the pump loop so they run.
    this.wake(run);
  }

  // ------------------------------------------------------------ pumping ---

  private async evalAndPump(run: ActiveRun, code: string): Promise<string> {
    const vm = run.context;
    const result = vm.evalCode(code, "guest.js");
    if (result.error) {
      const text = this.renderError(vm, result.error);
      result.error.dispose();
      throw new Error(text);
    }
    const completion = result.value;
    try {
      for (;;) {
        // The run may have been torn down while the loop was parked on a
        // wake (watchdog kill, dispose). Exit without touching the runtime.
        if (this.active !== run) {
          throw new Error("run aborted");
        }
        const state = vm.getPromiseState(completion);
        if (state.type === "fulfilled") {
          const value = state.value;
          // For a non-promise completion, the state value IS the completion
          // handle — the outer finally disposes it, so do not dispose twice.
          const isCompletion = state.notAPromise === true;
          try {
            if (vm.typeof(value) !== "string") {
              throw new Error("guest result must be a string");
            }
            return vm.getString(value);
          } finally {
            if (!isCompletion) value.dispose();
          }
        }
        if (state.type === "rejected") {
          const text = this.renderError(vm, state.error);
          state.error.dispose();
          throw new Error(text);
        }
        // Pending: run queued jobs, then yield so port messages (ask
        // replies, host sends) can arrive. The interrupt handler caps CPU
        // time inside evalCode/executePendingJobs; the loop below caps
        // waiting on a promise that never settles and has no asks out.
        const jobs = run.runtime.executePendingJobs();
        if (jobs.error) {
          const text = this.renderError(vm, jobs.error);
          jobs.error.dispose();
          throw new Error(text);
        }
        const executed = jobs.value;
        jobs.dispose();
        if (executed > 0) continue;
        if (Date.now() > run.deadlineAt && run.pendingAsks.size === 0) {
          throw new Error("run deadline exceeded while waiting for a guest promise");
        }
        await this.waitWake(run, 25);
      }
    } finally {
      completion.dispose();
      // The completion handle is gone now, so the runtime may be freed —
      // either here (normal exit) or, if teardown already ran, this is
      // the disposal teardown was waiting for.
      run.pumpExited = true;
      this.disposeRunResources(run);
    }
  }

  private waitWake(run: ActiveRun, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const index = run.wakeResolvers.indexOf(wake);
        if (index >= 0) run.wakeResolvers.splice(index, 1);
        resolve();
      }, ms);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      run.wakeResolvers.push(wake);
    });
  }

  private wake(run: ActiveRun): void {
    const resolvers = run.wakeResolvers;
    run.wakeResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  // ------------------------------------------------------------ helpers ---

  /**
   * Render a guest error handle as one line. vm.dump on an Error object
   * returns an object, not a string, so pick name/message out of it instead
   * of reporting "[object Object]".
   */
  private renderError(vm: QuickJSContext, handle: QuickJSHandle): string {
    const dumped = vm.dump(handle);
    if (typeof dumped === "string") return truncate(dumped, ERROR_TEXT_CAP);
    if (typeof dumped === "object" && dumped !== null) {
      const record = dumped as Record<string, unknown>;
      if (typeof record["message"] === "string") {
        const name = typeof record["name"] === "string" ? record["name"] : "Error";
        return truncate(`${name}: ${record["message"]}`, ERROR_TEXT_CAP);
      }
      try {
        return truncate(JSON.stringify(dumped) ?? String(dumped), ERROR_TEXT_CAP);
      } catch {
        return truncate(String(dumped), ERROR_TEXT_CAP);
      }
    }
    return truncate(String(dumped), ERROR_TEXT_CAP);
  }

  private accountOutput(run: ActiveRun, text: string): void {
    run.outputBytes += this.textEncoder.encode(text).length;
    if (run.outputBytes > run.limits.maxTotalOutputBytes) {
      throw new Error("guest exceeded maxTotalOutputBytes");
    }
  }

  private reply(message: WorkerToHostMessage): void {
    this.sendRaw(encodeMessage(message));
  }
}

export type { HostToWorkerMessage };
