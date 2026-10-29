/**
 * Worker-side guest runner: the only code that ever touches QuickJS.
 *
 * One run = one fresh QuickJS runtime + context, disposed when the run
 * settles for any reason. A runtime is never reused after an error — least
 * of all after an out-of-memory error, where the heap may be corrupt.
 *
 * The guest sees exactly one global besides the standard intrinsics: `host`,
 * with `host.send(string)`, `host.ask(name, arg?) -> Promise<string>`,
 * `host.fetchText(url) -> Promise<string>` (a gated host-side fetch —
 * see connections.ts; the guest itself has no network capability), and
 * `host.importModule(name) -> Promise<namespace>` (a gated, cached
 * dynamic import for computed specifiers — see imports.ts).
 * On top of that, the host may configure transparent bridged globals
 * (bridge.ts): plain names like alert() or localStorage.setItem() that
 * the guest calls normally, each call forwarded to the host. A name the
 * host did not configure simply does not exist in the guest realm.
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
import {
  isModuleCode,
  resolveSpecifier,
  scanDynamicImportSpecifiers,
  scanModuleSpecifiers,
  type ImportMap,
} from "./imports.js";
import type { BridgeSpec, JsonValue } from "./bridge.js";

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
  /**
   * Import fetches outstanding during the pre-evaluation import
   * resolution. Plain JS promises (no QuickJS handles), so teardown
   * only rejects them — nothing to dispose.
   */
  pendingImports: Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>;
  /** The run's import map (host-supplied, per run). */
  importMap: ImportMap;
  /** Pre-fetched module sources, keyed by resolved URL. The module
   * loader's only source of truth; grows as host.importModule calls
   * fetch more modules mid-run. */
  modules: Map<string, string>;
  loaderInstalled: boolean;
  /**
   * Module evaluations started by host.importModule whose top-level
   * await has not settled yet. The pump loop settles these alongside
   * the run's main completion (their jobs share the same queue).
   */
  pendingModuleEvals: Array<{ promise: QuickJSHandle; deferred: QuickJSDeferredPromise }>;
  /**
   * Host-configured transparent globals (bridge.ts): the shape-only
   * spec. The worker installs these names in the guest realm; each
   * call crosses the port to the host's implementation.
   */
  bridge: BridgeSpec;
  /**
   * Host-defined allowlist of guest globals the host may invoke
   * (dotted paths, e.g. "myApp.utils.format"). The guest cannot
   * expand this list; invoke-guest for any other path is rejected.
   */
  guestFunctions: string[];
  /** Bridged-global calls awaiting the host's answer. */
  pendingBridges: Map<number, QuickJSDeferredPromise>;
  /**
   * Host-initiated guest invocations whose (possibly async) guest
   * function has not settled yet. Settled by the pump loop, which
   * replies invoke-result/invoke-error to the host.
   */
  pendingInvokes: Array<{ promise: QuickJSHandle; invokeId: number }>;
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
  private nextImportId = 1;
  private nextBridgeId = 1;
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
        void this.startRun(
          message.id,
          message.code,
          message.limits,
          message.imports,
          message.bridge ?? {},
          message.guestFunctions ?? [],
        );
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
      case "import-result":
        this.settleImport(message.id, true, message.value);
        return;
      case "import-error":
        this.settleImport(message.id, false, message.error);
        return;
      case "bridge-result":
        this.settleBridge(message.id, true, message.value);
        return;
      case "bridge-error":
        this.settleBridge(message.id, false, message.error);
        return;
      case "invoke-guest":
        this.handleGuestInvoke(message.id, message.path, message.arg);
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

  private async startRun(
    id: number,
    code: string,
    limits: ResolvedLimits,
    imports: ImportMap,
    bridge: BridgeSpec,
    guestFunctions: string[],
  ): Promise<void> {
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
      pendingImports: new Map(),
      importMap: imports,
      modules: new Map(),
      loaderInstalled: false,
      pendingModuleEvals: [],
      bridge,
      guestFunctions,
      pendingBridges: new Map(),
      pendingInvokes: [],
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
      this.installBridgedGlobals(run);
      // The import graph is pre-fetched before evaluation: static
      // imports AND string-literal dynamic imports (see imports.ts for
      // why the loader must be fed up front). A classic script that
      // lazy-loads a package keeps classic semantics — its completion
      // value is preserved — while import() resolves from the
      // pre-fetched map and the guest re-renders with the module.
      const staticModule = isModuleCode(code);
      const seeds = [
        ...scanModuleSpecifiers(code),
        ...scanDynamicImportSpecifiers(code),
      ].map((specifier) => ({ specifier, base: null as string | null, depth: 0 }));
      if (staticModule || seeds.length > 0) {
        await this.prefetchImports(run, seeds);
      }
      const result = await this.evalAndPump(run, code, staticModule);
      this.accountOutput(run, result);
      this.reply({ t: "result", id, value: result });
    } catch (error) {
      this.reply({ t: "error", id, error: errorText(error) });
    } finally {
      this.teardownRun(run);
    }
  }

  /**
   * Resolve and download an import graph into the run's module map.
   * Breadth-first: each specifier resolves (import map or relative to
   * its importing module's URL) and is fetched once from the host,
   * which routes the download through the connection gate — so the
   * first download from an origin prompts, a granted origin downloads
   * silently, and the host-side cache means a second run never
   * downloads it again. Fetched sources contribute both their static
   * and their literal-dynamic imports to the walk. Bounded by
   * maxImportModules, maxImportDepth, and the run deadline; any
   * failure names the specifier.
   */
  private async prefetchImports(
    run: ActiveRun,
    initial: Array<{ specifier: string; base: string | null; depth: number }>,
  ): Promise<void> {
    const queue = [...initial];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      if (item.depth > run.limits.maxImportDepth) {
        throw new Error("guest exceeded maxImportDepth");
      }
      if (Date.now() > run.deadlineAt) {
        throw new Error("run deadline exceeded while fetching imports");
      }
      const url = resolveSpecifier(item.specifier, item.base, run.importMap);
      if (seen.has(url)) continue;
      seen.add(url);
      if (run.modules.size >= run.limits.maxImportModules) {
        throw new Error("guest exceeded maxImportModules");
      }
      const source = await this.requestImport(run, url);
      run.modules.set(url, source);
      for (const specifier of [
        ...scanModuleSpecifiers(source),
        ...scanDynamicImportSpecifiers(source),
      ]) {
        queue.push({ specifier, base: url, depth: item.depth + 1 });
      }
    }
  }

  /**
   * Fetch one module and its transitive graph into the run's module
   * map (for host.importModule). A module already in the map is reused
   * without a new download; its deps are still walked so a partially
   * known graph completes. Returns the root module's source.
   */
  private async fetchModuleGraph(run: ActiveRun, rootUrl: string): Promise<string> {
    let source = run.modules.get(rootUrl);
    if (source === undefined) {
      if (run.modules.size >= run.limits.maxImportModules) {
        throw new Error("guest exceeded maxImportModules");
      }
      source = await this.requestImport(run, rootUrl);
      run.modules.set(rootUrl, source);
    }
    const seeds = [
      ...scanModuleSpecifiers(source),
      ...scanDynamicImportSpecifiers(source),
    ].map((specifier) => ({ specifier, base: rootUrl as string | null, depth: 1 }));
    await this.prefetchImports(run, seeds);
    return source;
  }

  /**
   * Install the runtime's module loader and normalizer (once per run).
   * The normalizer canonicalizes every specifier (import map for bare
   * names, URL resolution for relatives); the loader serves only what
   * prefetch or host.importModule already downloaded. A specifier the
   * walker never saw fails here with its name attached — and, for a
   * computed dynamic import, with a pointer to host.importModule,
   * which is the call that CAN fetch it.
   */
  private ensureModuleLoader(run: ActiveRun): void {
    if (run.loaderInstalled) return;
    run.loaderInstalled = true;
    run.runtime.setModuleLoader(
      (normalizedName: string) => {
        const source = run.modules.get(normalizedName);
        if (source === undefined) {
          return {
            error: new Error(
              `module not prefetched: ${normalizedName} ` +
                `(for a computed specifier, use host.importModule(name))`,
            ),
          };
        }
        return source;
      },
      (baseModuleName: string, requestedName: string) => {
        const base = /^https?:\/\//.test(baseModuleName) ? baseModuleName : null;
        try {
          const url = resolveSpecifier(requestedName, base, run.importMap);
          // A bare map key that was never downloaded ahead of time can
          // only come from a computed import() — static imports and
          // literal dynamic imports are always pre-fetched, and a
          // fetched module's own imports are walked with it. QuickJS
          // replaces loader failures with its own generic text, so the
          // guidance has to live here, where the message survives.
          if (
            run.importMap[requestedName] !== undefined &&
            !run.modules.has(url)
          ) {
            return {
              error: new Error(
                `module "${requestedName}" was not downloaded ahead of time; ` +
                  `for a computed import() use host.importModule("${requestedName}")`,
              ),
            };
          }
          return url;
        } catch (error) {
          return { error: error instanceof Error ? error : new Error(String(error)) };
        }
      },
    );
  }

  private requestImport(run: ActiveRun, url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const id = this.nextImportId;
      this.nextImportId += 1;
      run.pendingImports.set(id, { resolve, reject });
      this.reply({ t: "import-request", id, url });
    });
  }

  private settleImport(id: number, ok: boolean, value: string): void {
    const run = this.active;
    if (run === null) return;
    const pending = run.pendingImports.get(id);
    if (pending === undefined) return;
    run.pendingImports.delete(id);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(value));
  }

  // ------------------------------------------------- bridged globals ---

  /**
   * Install the host-configured transparent globals (bridge.ts) in the
   * guest realm. Each leaf becomes a function the guest calls like any
   * normal API — alert("hi"), localStorage.setItem("k", "v") — and each
   * call crosses the port to the host's implementation. A name the host
   * did not configure is simply absent (ReferenceError, fail closed).
   */
  private installBridgedGlobals(run: ActiveRun): void {
    const vm = run.context;
    if (Object.keys(run.bridge).length === 0) return;
    Scope.withScope((scope) => {
      for (const [name, spec] of Object.entries(run.bridge)) {
        const value = scope.manage(this.makeBridgeValue(run, [name], spec));
        vm.setProp(vm.global, name, value);
      }
    });
  }

  private makeBridgeValue(
    run: ActiveRun,
    path: string[],
    spec: "function" | BridgeSpec,
  ): QuickJSHandle {
    const vm = run.context;
    if (spec === "function") {
      // The callback's args are borrowed handles (never freed here);
      // the returned promise handle is owned by the deferred and
      // disposed when the bridge settles.
      return vm.newFunction(path.join("."), (...args: QuickJSHandle[]) =>
        this.guestBridgeCall(run, path, args),
      );
    }
    const obj = vm.newObject();
    for (const [key, child] of Object.entries(spec)) {
      const childHandle = this.makeBridgeValue(run, [...path, key], child);
      try {
        vm.setProp(obj, key, childHandle);
      } finally {
        childHandle.dispose();
      }
    }
    return obj;
  }

  /**
   * One guest call of a bridged global. Arguments are dumped to JSON
   * (anything not JSON-serializable fails loudly in the guest); the
   * host answers with a JSON value that becomes the awaited result.
   * Bridged calls are async by physics — they cross the worker
   * boundary — so the guest always gets a promise back.
   */
  private guestBridgeCall(
    run: ActiveRun,
    path: string[],
    args: QuickJSHandle[],
  ): QuickJSHandle {
    const vm = run.context;
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args.map((arg) => vm.dump(arg)));
    } catch {
      throw new Error(
        `bridge call "${path.join(".")}": arguments must be JSON-serializable`,
      );
    }
    if (run.pendingBridges.size >= run.limits.maxOutstandingAsks) {
      throw new Error(`bridge call "${path.join(".")}": too many outstanding bridge calls`);
    }
    const deferred = vm.newPromise();
    const bridgeId = this.nextBridgeId;
    this.nextBridgeId += 1;
    run.pendingBridges.set(bridgeId, deferred);
    this.reply({ t: "bridge-call", id: bridgeId, path: path.join("."), args: argsJson });
    return deferred.handle;
  }

  private settleBridge(id: number, ok: boolean, value: string): void {
    const run = this.active;
    if (run === null) return;
    const deferred = run.pendingBridges.get(id);
    if (deferred === undefined) return;
    run.pendingBridges.delete(id);
    const vm = run.context;
    try {
      if (!ok) {
        const reason = vm.newString(value);
        try {
          deferred.reject(reason);
        } finally {
          reason.dispose();
        }
        return;
      }
      // The host answers with JSON; the guest awaits the real value,
      // not the JSON text. A host function returning undefined arrives
      // as null (see bridge.ts).
      const parsed: unknown = JSON.parse(value);
      const handle = this.jsonToHandle(vm, parsed);
      try {
        deferred.resolve(handle);
      } finally {
        handle.dispose();
      }
    } catch (error) {
      try {
        const reason = vm.newString(errorText(error));
        try {
          deferred.reject(reason);
        } finally {
          reason.dispose();
        }
      } catch {
        // The runtime may be mid-teardown; the pump loop will surface it.
      }
    } finally {
      try {
        deferred.dispose();
      } catch {
        // ignore
      }
    }
    this.wake(run);
  }

  /** Build a QuickJS value from parsed JSON. Only JSON shapes arrive here. */
  private jsonToHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
    if (value === null) return vm.null;
    if (value === undefined) return vm.undefined;
    switch (typeof value) {
      case "string":
        return vm.newString(value);
      case "number":
        return vm.newNumber(value);
      case "boolean":
        return value ? vm.true : vm.false;
      case "object": {
        if (Array.isArray(value)) {
          const arr = vm.newArray();
          try {
            let index = 0;
            for (const entry of value) {
              const entryHandle = this.jsonToHandle(vm, entry);
              try {
                vm.setProp(arr, String(index), entryHandle);
              } finally {
                entryHandle.dispose();
              }
              index++;
            }
          } catch (error) {
            arr.dispose();
            throw error;
          }
          return arr;
        }
        const obj = vm.newObject();
        try {
          for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const entryHandle = this.jsonToHandle(vm, entry);
            try {
              vm.setProp(obj, key, entryHandle);
            } finally {
              entryHandle.dispose();
            }
          }
        } catch (error) {
          obj.dispose();
          throw error;
        }
        return obj;
      }
      default:
        throw new Error("bridge result is not JSON-serializable");
    }
  }

  // ------------------------------------------------- guest invocation ---

  /**
   * Handle one host->guest invocation. The path must be in the host's
   * allowlist (the guest cannot expand it); it resolves through own
   * properties only — never the prototype chain — and the final value
   * must be a function, called with its parent object as `this`. A
   * synchronous function replies immediately; an async one is settled
   * by the pump loop, which also bounds it by the run deadline.
   */
  private handleGuestInvoke(id: number, path: string, arg: string): void {
    const run = this.active;
    if (run === null) {
      this.reply({ t: "invoke-error", id, error: "no active run to invoke a guest function on" });
      return;
    }
    const vm = run.context;
    try {
      if (!run.guestFunctions.includes(path)) {
        throw new Error(`guest function "${path}" is not allowed`);
      }
      const resolved = this.resolveGuestPath(vm, path);
      try {
        const argHandle = vm.newString(arg);
        try {
          const call = vm.callFunction(resolved.func, resolved.thisArg, argHandle);
          if (call.error) {
            const text = this.renderError(vm, call.error);
            call.error.dispose();
            throw new Error(text);
          }
          const completion = call.value;
          const state = vm.getPromiseState(completion);
          if (state.type === "fulfilled" && state.notAPromise === true) {
            // Synchronous guest function: the result must be a string,
            // like every other guest->host value on the wire.
            try {
              if (vm.typeof(completion) !== "string") {
                throw new Error("guest function must return a string");
              }
              this.reply({ t: "invoke-result", id, value: vm.getString(completion) });
            } finally {
              completion.dispose();
            }
            return;
          }
          if (state.type === "rejected") {
            const text = this.renderError(vm, state.error);
            state.error.dispose();
            completion.dispose();
            throw new Error(text);
          }
          // Async guest function: the pump loop settles it (and bounds it
          // by the run deadline like everything else).
          run.pendingInvokes.push({ promise: completion, invokeId: id });
          this.wake(run);
        } finally {
          argHandle.dispose();
        }
      } finally {
        resolved.func.dispose();
        resolved.thisArg.dispose();
      }
    } catch (error) {
      this.reply({ t: "invoke-error", id, error: errorText(error) });
    }
  }

  /**
   * Resolve a dotted path from the guest global, through own
   * properties only. Prototype-chain traversal (constructor,
   * __proto__, ...) cannot resolve: each step must be an own
   * property of the previous object.
   */
  private resolveGuestPath(
    vm: QuickJSContext,
    path: string,
  ): { func: QuickJSHandle; thisArg: QuickJSHandle } {
    const segments = path.split(".");
    let obj: QuickJSHandle = vm.global;
    try {
      for (let i = 0; i < segments.length; i++) {
        const key = segments[i] as string;
        if (!this.hasOwn(vm, obj, key)) {
          throw new Error(`guest function "${path}" does not exist`);
        }
        const next = vm.getProp(obj, key);
        if (i === segments.length - 1) {
          if (vm.typeof(next) !== "function") {
            next.dispose();
            throw new Error(`guest function "${path}" is not a function`);
          }
          return { func: next, thisArg: obj };
        }
        const type = vm.typeof(next);
        if (type !== "object" && type !== "function") {
          next.dispose();
          throw new Error(`guest function "${path}" does not exist`);
        }
        if (vm.dump(next) === null) {
          // typeof null is "object"; catch it before the next step.
          next.dispose();
          throw new Error(`guest function "${path}" does not exist`);
        }
        obj.dispose();
        obj = next;
      }
      throw new Error(`guest function "${path}" does not exist`);
    } catch (error) {
      obj.dispose();
      throw error;
    }
  }

  /** Own-property check via Object.prototype.hasOwnProperty. */
  private hasOwn(vm: QuickJSContext, obj: QuickJSHandle, key: string): boolean {
    return Scope.withScope((scope) => {
      const Object_ = scope.manage(vm.getProp(vm.global, "Object"));
      const proto = scope.manage(vm.getProp(Object_, "prototype"));
      const hasOwnProp = scope.manage(vm.getProp(proto, "hasOwnProperty"));
      const keyHandle = scope.manage(vm.newString(key));
      const result = vm.callFunction(hasOwnProp, obj, keyHandle);
      if (result.error) {
        const text = this.renderError(vm, result.error);
        result.error.dispose();
        throw new Error(text);
      }
      const out = vm.dump(result.value);
      result.value.dispose();
      return out === true;
    });
  }

  /**
   * Settle host-initiated guest invocations whose async function
   * finished. Called each pump-loop iteration; replies invoke-result
   * (string results only, like every guest->host value) or
   * invoke-error. A run that dies with invokes outstanding leaves
   * them to teardown; the session rejects the host's promises.
   */
  private settleInvokes(run: ActiveRun): void {
    const vm = run.context;
    const remaining: typeof run.pendingInvokes = [];
    for (const entry of run.pendingInvokes) {
      let state;
      try {
        state = vm.getPromiseState(entry.promise);
      } catch {
        // Runtime mid-teardown; teardownRun disposes these.
        remaining.push(entry);
        continue;
      }
      if (state.type === "pending") {
        remaining.push(entry);
        continue;
      }
      try {
        if (state.type === "fulfilled") {
          const value = state.value;
          try {
            if (vm.typeof(value) !== "string") {
              throw new Error("guest function must return a string");
            }
            this.reply({ t: "invoke-result", id: entry.invokeId, value: vm.getString(value) });
          } finally {
            value.dispose();
          }
        } else {
          const text = this.renderError(vm, state.error);
          try {
            state.error.dispose();
          } catch {
            // ignore
          }
          this.reply({ t: "invoke-error", id: entry.invokeId, error: text });
        }
      } catch (error) {
        this.reply({ t: "invoke-error", id: entry.invokeId, error: errorText(error) });
      } finally {
        try {
          entry.promise.dispose();
        } catch {
          // ignore
        }
      }
    }
    run.pendingInvokes = remaining;
  }

  private teardownRun(run: ActiveRun): void {
    // Reject anything still outstanding so no deferred survives the run.
    this.rejectPending(run, run.pendingAsks);
    this.rejectPending(run, run.pendingFetches);
    run.pendingAsks.clear();
    run.pendingFetches.clear();
    for (const pending of run.pendingImports.values()) {
      pending.reject(new Error("run ended before the host answered the import"));
    }
    run.pendingImports.clear();
    this.rejectPending(run, run.pendingBridges);
    run.pendingBridges.clear();
    for (const entry of run.pendingInvokes) {
      // The run is gone; the host's invoke promise is rejected by the
      // session on run end. Dispose the guest-side handles only.
      try {
        entry.promise.dispose();
      } catch {
        // ignore
      }
    }
    run.pendingInvokes = [];
    for (const entry of run.pendingModuleEvals) {
      try {
        const reason = run.context.newString("run ended before the imported module settled");
        try {
          entry.deferred.reject(reason);
        } finally {
          reason.dispose();
        }
      } catch {
        // The runtime may already be unusable; disposal below still runs.
      } finally {
        try {
          entry.deferred.dispose();
        } catch {
          // ignore
        }
        try {
          entry.promise.dispose();
        } catch {
          // ignore
        }
      }
    }
    run.pendingModuleEvals = [];
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
      vm.setProp(
        host,
        "importModule",
        scope.manage(
          vm.newFunction("importModule", (specArg) => {
            return this.guestImportModule(run, specArg);
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

  /**
   * Dynamically import a module by name at runtime, for specifiers
   * that cannot be known ahead of time (a variable holding the name).
   * The name MUST be a key in the run's import map: the app decides
   * which packages exist, and the guest only picks among them. The
   * module — and its transitive graph — downloads through the gate,
   * is cached like any import, and evaluates in the guest realm; the
   * returned promise resolves with the module's namespace, so the
   * guest re-renders with it exactly like a lazy import() in a
   * browser. Awaiting the promise is what "downloaded, then
   * re-rendered" means for a computed name.
   */
  private guestImportModule(run: ActiveRun, specArg: QuickJSHandle): QuickJSHandle {
    const vm = run.context;
    if (vm.typeof(specArg) !== "string") {
      throw new Error("host.importModule: specifier must be a string");
    }
    const specifier = vm.getString(specArg);
    const url = run.importMap[specifier];
    if (url === undefined) {
      throw new Error(`host.importModule: unknown import "${specifier}" (not in the import map)`);
    }
    const deferred = vm.newPromise();
    void this.loadModuleForImport(run, url, deferred);
    return deferred.handle;
  }

  private async loadModuleForImport(
    run: ActiveRun,
    url: string,
    deferred: QuickJSDeferredPromise,
  ): Promise<void> {
    const vm = run.context;
    try {
      // Yield first so the module evaluation below never runs nested
      // inside the host-function call that started it.
      await Promise.resolve();
      this.ensureModuleLoader(run);
      const source = await this.fetchModuleGraph(run, url);
      const result = vm.evalCode(source, url, { type: "module" });
      if (result.error) {
        const text = this.renderError(vm, result.error);
        result.error.dispose();
        throw new Error(text);
      }
      const completion = result.value;
      const state = vm.getPromiseState(completion);
      if (state.type === "fulfilled" && state.notAPromise === true) {
        // Synchronous module: resolve with the namespace now.
        try {
          deferred.resolve(completion);
        } finally {
          completion.dispose();
          try {
            deferred.dispose();
          } catch {
            // ignore
          }
        }
        return;
      }
      if (state.type === "rejected") {
        const text = this.renderError(vm, state.error);
        state.error.dispose();
        completion.dispose();
        throw new Error(text);
      }
      // Top-level await: the pump loop settles this when the promise
      // does (its jobs share the run's queue).
      run.pendingModuleEvals.push({ promise: completion, deferred });
      this.wake(run);
    } catch (error) {
      try {
        const reason = vm.newString(errorText(error));
        try {
          deferred.reject(reason);
        } finally {
          reason.dispose();
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
    }
  }

  /**
   * Settle host.importModule evaluations whose top-level await
   * finished. Called each pump-loop iteration; their jobs run through
   * the same executePendingJobs queue as the run's main completion.
   */
  private settleModuleEvals(run: ActiveRun): void {
    const vm = run.context;
    const remaining: typeof run.pendingModuleEvals = [];
    for (const entry of run.pendingModuleEvals) {
      let state;
      try {
        state = vm.getPromiseState(entry.promise);
      } catch {
        // Runtime mid-teardown; teardownRun disposes these.
        remaining.push(entry);
        continue;
      }
      if (state.type === "pending") {
        remaining.push(entry);
        continue;
      }
      if (state.type === "fulfilled") {
        const value = state.value;
        try {
          entry.deferred.resolve(value);
        } catch {
          // ignore
        } finally {
          value.dispose();
          try {
            entry.deferred.dispose();
          } catch {
            // ignore
          }
        }
      } else {
        const text = this.renderError(vm, state.error);
        try {
          state.error.dispose();
        } catch {
          // ignore
        }
        try {
          const reason = vm.newString(text);
          try {
            entry.deferred.reject(reason);
          } finally {
            reason.dispose();
          }
        } catch {
          // ignore
        } finally {
          try {
            entry.deferred.dispose();
          } catch {
            // ignore
          }
        }
      }
      try {
        entry.promise.dispose();
      } catch {
        // ignore
      }
    }
    run.pendingModuleEvals = remaining;
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

  private async evalAndPump(
    run: ActiveRun,
    code: string,
    isModule: boolean,
  ): Promise<string> {
    const vm = run.context;
    // The loader is installed for module runs and for classic runs
    // whose prefetch found dynamic imports. Classic runs without any
    // imports keep no loader at all, exactly as before.
    if (isModule || run.modules.size > 0) {
      this.ensureModuleLoader(run);
    }
    const result = isModule
      ? vm.evalCode(code, "guest.js", { type: "module" })
      : vm.evalCode(code, "guest.js");
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
        // Settle any host.importModule top-level awaits before looking
        // at the main completion; their jobs share this queue.
        this.settleModuleEvals(run);
        // Same for host-initiated guest invocations: their jobs share
        // this queue, and the run deadline bounds them like everything
        // else. Replies go straight to the host.
        this.settleInvokes(run);
        const state = vm.getPromiseState(completion);
        if (state.type === "fulfilled") {
          const value = state.value;
          // For a non-promise completion, the state value IS the completion
          // handle — the outer finally disposes it, so do not dispose twice.
          const isCompletion = state.notAPromise === true;
          try {
            // A module's job is its side effects (host.send calls, event
            // handlers); its namespace is not a result. A module that
            // finishes synchronously resolves to "" — a top-level await
            // that fulfills with a string is the only way a module run
            // returns a value, mirroring the classic-script rule.
            if (isModule) {
              if (isCompletion) return "";
              if (vm.typeof(value) !== "string") return "";
              return vm.getString(value);
            }
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
