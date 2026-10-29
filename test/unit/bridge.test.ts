/**
 * Unit tests for the transparent host<->guest bridge (bridge.ts):
 * host-configured globals the guest calls like normal APIs, and
 * host->guest invocation of guest functions by dotted path.
 */
import { describe, expect, it } from "vitest";
import {
  isBridgeSpec,
  isDottedPath,
  normalizeBridgeGlobals,
  validateGuestFunctions,
  type BridgeSpec,
} from "../../src/bridge.js";
import { GuestRunner } from "../../src/guest-runner.js";
import { decodeMessage, encodeMessage } from "../../src/protocol.js";
import { resolveLimits } from "../../src/limits.js";

describe("normalizeBridgeGlobals", () => {
  it("builds the shape-only spec from nested config", () => {
    const spec = normalizeBridgeGlobals({
      alert: () => null,
      localStorage: {
        getItem: () => null,
        setItem: () => null,
        nested: { deep: () => null },
      },
    });
    expect(spec).toEqual({
      alert: "function",
      localStorage: { getItem: "function", setItem: "function", nested: { deep: "function" } },
    });
  });

  it("returns {} for undefined", () => {
    expect(normalizeBridgeGlobals(undefined)).toEqual({});
  });

  it("throws on non-function leaves", () => {
    expect(() => normalizeBridgeGlobals({ alert: "nope" } as never)).toThrow(/must be a function/);
    expect(() => normalizeBridgeGlobals({ n: 42 } as never)).toThrow(/must be a function/);
  });

  it("throws on arrays and empty names", () => {
    expect(() => normalizeBridgeGlobals({ a: [] } as never)).toThrow(/must be a function/);
    expect(() => normalizeBridgeGlobals({ "": () => null })).toThrow(/empty name/);
  });

  it("isBridgeSpec accepts the normalized shape and rejects junk", () => {
    expect(isBridgeSpec(normalizeBridgeGlobals({ a: () => null, b: { c: () => null } }))).toBe(
      true,
    );
    expect(isBridgeSpec({ a: "nope" })).toBe(false);
    expect(isBridgeSpec(null)).toBe(false);
    // A spec arriving over the port must never touch the prototype.
    expect(isBridgeSpec(JSON.parse('{"__proto__":"function"}'))).toBe(false);
  });

  it("rejects __proto__ as a configured name", () => {
    const evil = JSON.parse('{"__proto__":{}}');
    evil["__proto__"] = () => null;
    expect(() => normalizeBridgeGlobals(evil)).toThrow(/not an allowed name/);
  });
});

describe("validateGuestFunctions", () => {
  it("dedupes while keeping order", () => {
    expect(validateGuestFunctions(["a", "a.b", "a"])).toEqual(["a", "a.b"]);
  });

  it("returns [] for undefined and throws on bad paths", () => {
    expect(validateGuestFunctions(undefined)).toEqual([]);
    expect(() => validateGuestFunctions([""])).toThrow(/not a valid dotted path/);
    expect(() => validateGuestFunctions(["a..b"])).toThrow(/not a valid dotted path/);
    expect(() => validateGuestFunctions(["a."])).toThrow(/not a valid dotted path/);
  });

  it("isDottedPath checks segments", () => {
    expect(isDottedPath("a.b.c")).toBe(true);
    expect(isDottedPath("a")).toBe(true);
    expect(isDottedPath("")).toBe(false);
    expect(isDottedPath(".a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GuestRunner drivers: a fake host that answers bridge calls, and a
// driver that invokes guest functions mid-run.
// ---------------------------------------------------------------------------

interface BridgeCall {
  path: string;
  args: unknown[];
}

async function driveBridge(
  code: string,
  bridge: BridgeSpec,
  onBridge: (path: string, args: unknown[]) => unknown,
): Promise<{ messages: string[]; result: string; bridgeCalls: BridgeCall[] }> {
  const messages: string[] = [];
  const bridgeCalls: BridgeCall[] = [];
  let runner: GuestRunner | null = null;
  let settleRun: (outcome: { ok: boolean; value: string }) => void = () => undefined;
  const outcome = new Promise<{ ok: boolean; value: string }>((resolve) => {
    settleRun = resolve;
  });
  const sendRaw = (raw: string): void => {
    const decoded = decodeMessage(raw, 8 * 1024 * 1024);
    if (decoded === null) return;
    if (decoded.t === "message") {
      messages.push(decoded.message);
      return;
    }
    if (decoded.t === "result") {
      settleRun({ ok: true, value: decoded.value });
      return;
    }
    if (decoded.t === "error") {
      settleRun({ ok: false, value: decoded.error });
      return;
    }
    if (decoded.t === "bridge-call") {
      const call = { path: decoded.path, args: JSON.parse(decoded.args) as unknown[] };
      bridgeCalls.push(call);
      // Answer asynchronously, like a real port round trip.
      setTimeout(() => {
        try {
          const value = onBridge(call.path, call.args);
          Promise.resolve(value).then(
            (resolved) => {
              runner?.handleMessage(
                encodeMessage({
                  t: "bridge-result",
                  id: decoded.id,
                  value: JSON.stringify(resolved) ?? "null",
                }),
              );
            },
            (error: unknown) => {
              runner?.handleMessage(
                encodeMessage({
                  t: "bridge-error",
                  id: decoded.id,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            },
          );
        } catch (error: unknown) {
          runner?.handleMessage(
            encodeMessage({
              t: "bridge-error",
              id: decoded.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }, 0);
    }
  };
  runner = await GuestRunner.create(sendRaw);
  try {
    runner.handleMessage(
      encodeMessage({
        t: "run",
        id: 1,
        code,
        limits: resolveLimits({ deadlineMs: 10000 }),
        imports: {},
        bridge,
        guestFunctions: [],
      }),
    );
    const settled = await outcome;
    if (!settled.ok) throw new Error(settled.value);
    return { messages, result: settled.value, bridgeCalls };
  } finally {
    runner.dispose();
  }
}

const BRIDGE: BridgeSpec = {
  alert: "function",
  localStorage: { getItem: "function", setItem: "function" },
};

function memoryStorage() {
  const store: Record<string, string> = {};
  return (path: string, args: unknown[]): unknown => {
    if (path === "alert") return null;
    if (path === "localStorage.setItem") {
      store[String(args[0])] = String(args[1]);
      return null;
    }
    if (path === "localStorage.getItem") {
      const value = store[String(args[0])];
      return value === undefined ? null : value;
    }
    throw new Error(`unexpected bridge call: ${path}`);
  };
}

describe("GuestRunner bridged globals (guest -> host)", () => {
  it("guest calls a plain host function transparently", async () => {
    const { messages, bridgeCalls, result } = await driveBridge(
      `(async () => { await alert("hi"); host.send("called"); return "done"; })()`,
      BRIDGE,
      memoryStorage(),
    );
    expect(bridgeCalls).toEqual([{ path: "alert", args: ["hi"] }]);
    expect(messages).toEqual(["called"]);
    expect(result).toBe("done");
  });

  it("guest uses a nested namespace (localStorage)", async () => {
    const { messages } = await driveBridge(
      `(async () => {
         await localStorage.setItem("theme", "dark");
         const v = await localStorage.getItem("theme");
         const missing = await localStorage.getItem("nope");
         host.send(v + "|" + String(missing)); return "done";
       })()`,
      BRIDGE,
      memoryStorage(),
    );
    expect(messages).toEqual(["dark|null"]);
  });

  it("object return values keep their shape", async () => {
    const { messages } = await driveBridge(
      `(async () => {
         const cfg = await getConfig();
         host.send(cfg.retries + ":" + cfg.tags.join(",")); return "done";
       })()`,
      { getConfig: "function" },
      (path) => {
        if (path === "getConfig") return { retries: 3, tags: ["a", "b"] };
        throw new Error("unexpected");
      },
    );
    expect(messages).toEqual(["3:a,b"]);
  });

  it("an unconfigured global is a ReferenceError in the guest", async () => {
    const { messages } = await driveBridge(
      `let name = "none";
       try { window.open("x"); } catch (e) { name = e.name; }
       host.send(name); "done"`,
      BRIDGE,
      memoryStorage(),
    );
    expect(messages).toEqual(["ReferenceError"]);
  });

  it("a host failure rejects the guest's await", async () => {
    const { messages } = await driveBridge(
      `(async () => {
         let msg = "none";
         try { await alert("boom"); } catch (e) { msg = String(e); }
         host.send(msg); return "done";
       })()`,
      BRIDGE,
      () => {
        throw new Error("host said no");
      },
    );
    expect(messages).toEqual(["host said no"]);
  });

  it("non-JSON-serializable arguments fail loudly in the guest", async () => {
    const { messages } = await driveBridge(
      `(async () => {
         let msg = "none";
         try { await alert(10n); } catch (e) { msg = e.message; }
         host.send(msg); return "done";
       })()`,
      BRIDGE,
      memoryStorage(),
    );
    expect(messages[0]).toMatch(/JSON-serializable/);
  });
});

// ---------------------------------------------------------------------------
// Host -> guest invocation driver. The guest defines functions, signals
// readiness, then parks on a gate the driver opens with a "stop" message.
// ---------------------------------------------------------------------------

interface InvokeOutcome {
  ok: boolean;
  value: string;
}

async function driveInvokes(
  guestFunctions: string[],
  invokes: Array<{ path: string; arg: string }>,
): Promise<InvokeOutcome[]> {
  const outcomes: InvokeOutcome[] = [];
  let runner: GuestRunner | null = null;
  let settleRun: (outcome: { ok: boolean; value: string }) => void = () => undefined;
  const outcome = new Promise<{ ok: boolean; value: string }>((resolve) => {
    settleRun = resolve;
  });
  const pending = new Map<number, (o: InvokeOutcome) => void>();
  let nextId = 1;
  const sendRaw = (raw: string): void => {
    const decoded = decodeMessage(raw, 8 * 1024 * 1024);
    if (decoded === null) return;
    if (decoded.t === "message" && decoded.message === "up") {
      for (const invoke of invokes) {
        const id = nextId++;
        pending.set(id, (o) => outcomes.push(o));
        runner?.handleMessage(encodeMessage({ t: "invoke-guest", id, ...invoke }));
      }
      return;
    }
    if (decoded.t === "invoke-result") {
      pending.get(decoded.id)?.({ ok: true, value: decoded.value });
      pending.delete(decoded.id);
      maybeStop();
      return;
    }
    if (decoded.t === "invoke-error") {
      pending.get(decoded.id)?.({ ok: false, value: decoded.error });
      pending.delete(decoded.id);
      maybeStop();
      return;
    }
    if (decoded.t === "result") {
      settleRun({ ok: true, value: decoded.value });
      return;
    }
    if (decoded.t === "error") {
      settleRun({ ok: false, value: decoded.error });
      return;
    }
  };
  const maybeStop = (): void => {
    if (pending.size === 0) {
      runner?.handleMessage(encodeMessage({ t: "send", message: "stop" }));
    }
  };
  const code = `
    function render(d) { return "rendered:" + d; }
    async function slow(d) { const v = await Promise.resolve("slow:" + d); return v; }
    globalThis.numFn = function() { return 42; };
    // Invokable state must live on globalThis: top-level const/let
    // (and module-scope declarations) are not global-object
    // properties, so the host cannot resolve them by path.
    globalThis.myApp = {
      prefix: "P:",
      show() { return this.prefix + "!"; },
      utils: { format(n) { return Number(n).toFixed(2); } },
      count: 41,
    };
    let stop;
    const gate = new Promise((res) => { stop = res; });
    globalThis.onMessage = (m) => { if (m === "stop") stop("finished"); };
    host.send("up");
    (async () => { await gate; return "finished"; })()
  `;
  runner = await GuestRunner.create(sendRaw);
  try {
    runner.handleMessage(
      encodeMessage({
        t: "run",
        id: 1,
        code,
        limits: resolveLimits({ deadlineMs: 10000 }),
        imports: {},
        bridge: {},
        guestFunctions,
      }),
    );
    const settled = await outcome;
    if (!settled.ok) throw new Error(settled.value);
    expect(settled.value).toBe("finished");
    return outcomes;
  } finally {
    runner.dispose();
  }
}

describe("GuestRunner guest invocation (host -> guest)", () => {
  it("invokes a top-level guest function", async () => {
    const outcomes = await driveInvokes(["render"], [{ path: "render", arg: "rows" }]);
    expect(outcomes).toEqual([{ ok: true, value: "rendered:rows" }]);
  });

  it("invokes a dotted-path method", async () => {
    const outcomes = await driveInvokes(["myApp.utils.format"], [
      { path: "myApp.utils.format", arg: "3.14159" },
    ]);
    expect(outcomes).toEqual([{ ok: true, value: "3.14" }]);
  });

  it("calls the method with its parent as this", async () => {
    const outcomes = await driveInvokes(["myApp.show"], [{ path: "myApp.show", arg: "" }]);
    expect(outcomes).toEqual([{ ok: true, value: "P:!" }]);
  });

  it("awaits an async guest function", async () => {
    const outcomes = await driveInvokes(["slow"], [{ path: "slow", arg: "x" }]);
    expect(outcomes).toEqual([{ ok: true, value: "slow:x" }]);
  });

  it("rejects a path outside the allowlist", async () => {
    const outcomes = await driveInvokes(["render"], [{ path: "slow", arg: "x" }]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.value).toMatch(/not allowed/);
  });

  it("rejects a non-function final value", async () => {
    const outcomes = await driveInvokes(["myApp.count"], [{ path: "myApp.count", arg: "" }]);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.value).toMatch(/not a function/);
  });

  it("rejects a missing path", async () => {
    const outcomes = await driveInvokes(["nope"], [{ path: "nope", arg: "" }]);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.value).toMatch(/does not exist/);
  });

  it("rejects prototype-chain traversal", async () => {
    const outcomes = await driveInvokes(["myApp.constructor", "myApp.__proto__"], [
      { path: "myApp.constructor", arg: "" },
      { path: "myApp.__proto__", arg: "" },
    ]);
    expect(outcomes).toHaveLength(2);
    for (const o of outcomes) {
      expect(o.ok).toBe(false);
      expect(o.value).toMatch(/does not exist/);
    }
  });

  it("rejects a non-string return", async () => {
    const outcomes = await driveInvokes(["numFn"], [{ path: "numFn", arg: "" }]);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.value).toMatch(/must return a string/);
  });

  it("invoke-guest with no active run errors", async () => {
    let replyT = "";
    let replyError = "";
    const runner = await GuestRunner.create((raw: string) => {
      const decoded = decodeMessage(raw, 8 * 1024 * 1024);
      if (decoded === null) return;
      if (decoded.t === "invoke-result") replyT = "invoke-result";
      if (decoded.t === "invoke-error") {
        replyT = "invoke-error";
        replyError = decoded.error;
      }
    });
    try {
      runner.handleMessage(encodeMessage({ t: "invoke-guest", id: 7, path: "x", arg: "" }));
      expect(replyT).toBe("invoke-error");
      expect(replyError).toMatch(/no active run/);
    } finally {
      runner.dispose();
    }
  });
});

describe("protocol: bridge messages", () => {
  it("decodes bridge-call and invoke-guest", () => {
    expect(
      decodeMessage(encodeMessage({ t: "bridge-call", id: 1, path: "a.b", args: "[1]" }), 1024),
    ).toEqual({ t: "bridge-call", id: 1, path: "a.b", args: "[1]" });
    expect(
      decodeMessage(encodeMessage({ t: "invoke-guest", id: 2, path: "f", arg: "x" }), 1024),
    ).toEqual({ t: "invoke-guest", id: 2, path: "f", arg: "x" });
  });

  it("rejects malformed bridge messages", () => {
    expect(decodeMessage('{"t":"bridge-call","id":1}', 1024)).toBeNull();
    expect(decodeMessage('{"t":"invoke-guest","id":1,"path":1,"arg":"x"}', 1024)).toBeNull();
  });

  it("run accepts optional bridge and guestFunctions", () => {
    const decoded = decodeMessage(
      encodeMessage({
        t: "run",
        id: 1,
        code: "1",
        limits: resolveLimits({}),
        imports: {},
        bridge: { alert: "function" },
        guestFunctions: ["render"],
      }),
      1024 * 1024,
    );
    expect(decoded).toMatchObject({
      t: "run",
      bridge: { alert: "function" },
      guestFunctions: ["render"],
    });
  });

  it("run rejects a malformed bridge spec", () => {
    const decoded = decodeMessage(
      JSON.stringify({
        t: "run",
        id: 1,
        code: "1",
        limits: resolveLimits({}),
        imports: {},
        bridge: { alert: "nope" },
      }),
      1024 * 1024,
    );
    expect(decoded).toBeNull();
  });
});
