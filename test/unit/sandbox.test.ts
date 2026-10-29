/**
 * Unit tests for the sandbox core (Session + GuestRunner, in-process).
 * These run in Node against the real embedded QuickJS build; the browser
 * suite covers the iframe/worker/CSP integration itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPair, type Pair } from "./harness.js";

let pair: Pair | null = null;

afterEach(() => {
  pair?.close();
  pair = null;
});

async function fresh(): Promise<Pair> {
  pair = await createPair();
  return pair;
}

describe("guest globals probe", () => {
  it("exposes host but no network, timer, DOM, or Node globals", async () => {
    const { session } = await fresh();
    const probe = await session.run(`
      const names = ["fetch", "XMLHttpRequest", "WebSocket", "setTimeout",
        "setInterval", "process", "require", "module", "document", "window",
        "localStorage", "indexedDB", "Worker", "importScripts", "navigator"];
      const missing = names.filter((n) => typeof globalThis[n] === "undefined");
      const present = names.filter((n) => typeof globalThis[n] !== "undefined");
      "missing=" + missing.length + ";present=" + present.join(",") +
        ";host=" + typeof globalThis.host;
    `);
    expect(probe).toBe(
      "missing=15;present=;host=object",
    );
  });
});

describe("round trips", () => {
  it("guest -> host messages arrive via on('message')", async () => {
    const { session } = await fresh();
    const received: string[] = [];
    session.on("message", (message) => {
      received.push(message);
    });
    const result = await session.run(`host.send("hello from guest"); "done"`);
    expect(result).toBe("done");
    expect(received).toEqual(["hello from guest"]);
  });

  it("host -> guest -> host round trip through onMessage", async () => {
    const { session } = await fresh();
    const received: string[] = [];
    session.on("message", (message) => {
      received.push(message);
    });
    // The guest returns a promise that settles when the host message
    // arrives; the run stays in flight until then.
    const runPromise = session.run(`
      new Promise((resolve) => {
        globalThis.onMessage = (m) => {
          host.send("echo:" + m);
          resolve(m);
        };
      });
    `);
    session.send("ping");
    await expect(runPromise).resolves.toBe("ping");
    expect(received).toContain("echo:ping");
  });
});

describe("async ask", () => {
  it("guest awaits a registered ask and gets the string back", async () => {
    const { session } = await fresh();
    session.registerAsk("upper", (arg) => arg.toUpperCase());
    // Guest code is a classic script: no top-level await. Async guests
    // wrap their body in an async IIFE; the runner awaits the promise.
    const result = await session.run(
      `(async () => { return await host.ask("upper", "hello"); })()`,
    );
    expect(result).toBe("HELLO");
  });

  it("guest ask with an unregistered name rejects in the guest", async () => {
    const { session } = await fresh();
    await expect(
      session.run(`(async () => { await host.ask("nope", "x"); })()`),
    ).rejects.toThrow(/ask not registered/);
  });

  it("an ask handler returning a non-string is reported as an error", async () => {
    const { session } = await fresh();
    session.registerAsk("bad", () => 42 as unknown as string);
    await expect(
      session.run(`(async () => { await host.ask("bad"); })()`),
    ).rejects.toThrow(/non-string/);
  });
});

describe("gated connections", () => {
  it("guest fetchText returns the host-fetched body", async () => {
    const { session } = await fresh();
    session.onConnectionRequest = async (url) => `body for ${url}`;
    const result = await session.run(
      `(async () => { return await host.fetchText("https://cdn.example/x.css"); })()`,
    );
    expect(result).toBe("body for https://cdn.example/x.css");
  });

  it("guest fetchText fails closed when no connection handler is set", async () => {
    const { session } = await fresh();
    await expect(
      session.run(
        `(async () => { await host.fetchText("https://cdn.example/x.css"); })()`,
      ),
    ).rejects.toThrow(/not enabled/);
  });

  it("guest fetchText with a non-string url throws inside the guest", async () => {
    const { session } = await fresh();
    session.onConnectionRequest = async () => "x";
    await expect(
      session.run(`(async () => { await host.fetchText(42); })()`),
    ).rejects.toThrow(/host\.fetchText: url must be a string/);
  });

  it("outstanding fetch cap stops fetch spam", async () => {
    const { session } = await fresh();
    session.onConnectionRequest = () => new Promise(() => undefined as never);
    await expect(
      session.run(
        `const ps = []; for (let i = 0; i < 10; i++) { ps.push(host.fetchText("https://a.example/" + i)); } "done"`,
        { maxOutstandingFetches: 4 },
      ),
    ).rejects.toThrow(/too many outstanding fetches/);
  });
});

describe("type validation", () => {
  it("guest host.send with a non-string throws inside the guest", async () => {
    const { session } = await fresh();
    await expect(session.run(`host.send(42); "ok"`)).rejects.toThrow(
      /host\.send: argument must be a string/,
    );
  });

  it("guest host.ask with a non-string name throws inside the guest", async () => {
    const { session } = await fresh();
    await expect(
      session.run(`(async () => { await host.ask(42); })()`),
    ).rejects.toThrow(/host\.ask: name must be a string/);
  });

  it("host session.send with a non-string throws synchronously", async () => {
    const { session } = await fresh();
    expect(() => session.send(42 as unknown as string)).toThrow(/must be a string/);
  });

  it("a guest result that is not a string is rejected", async () => {
    const { session } = await fresh();
    await expect(session.run(`42`)).rejects.toThrow(/guest result must be a string/);
  });
});

describe("limits", () => {
  it("infinite loop is interrupted by the deadline", async () => {
    const { session } = await fresh();
    const start = Date.now();
    await expect(session.run(`while (true) {}`, { deadlineMs: 200 })).rejects.toThrow(
      /interrupted|deadline/,
    );
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("memory bomb hits the memory limit, not the deadline", async () => {
    const { session } = await fresh();
    // Objects and array storage count against setMemoryLimit and fail fast.
    await expect(
      session.run(`let a = []; for (let i = 0; i < 1000000; i++) { a.push({ v: i }); } "done"`, {
        deadlineMs: 5000,
        memoryLimitBytes: 2 * 1024 * 1024,
      }),
    ).rejects.toThrow(/memory|out of memory/i);
  });

  it("string bomb is stopped by the deadline, not the memory limit", async () => {
    // Measured 2026-10-28: QuickJS's memory limit does NOT charge string
    // payload bytes in this build (300 x 10 KiB strings pass a 2 MiB limit),
    // so a string accumulator grows until the wasm heap or the deadline
    // stops it. The deadline interrupt is the backstop; see the README.
    const { session } = await fresh();
    const start = Date.now();
    await expect(
      session.run(`let a = []; while (true) { a.push("x".repeat(10000)); }`, {
        deadlineMs: 500,
        memoryLimitBytes: 2 * 1024 * 1024,
      }),
    ).rejects.toThrow(/interrupted|deadline/);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("runaway recursion hits the stack limit and the host survives", async () => {
    const { session } = await fresh();
    await expect(
      session.run(`function f() { return f(); } f()`, { deadlineMs: 5000 }),
    ).rejects.toThrow(/stack|overflow|maximum call/i);
    // The sandbox is still usable: a fresh runtime serves the next run.
    await expect(session.run(`"alive"`)).resolves.toBe("alive");
  });

  it("a maxStackSize above 256 KiB is rejected, never clamped", async () => {
    const { session } = await fresh();
    await expect(session.run(`"x"`, { maxStackSize: 512 * 1024 })).rejects.toThrow(
      /256 KiB or less/,
    );
  });

  it("oversized guest message is rejected inside the guest", async () => {
    const { session } = await fresh();
    await expect(
      session.run(`host.send("x".repeat(70 * 1024)); "ok"`, {
        maxMessageSize: 64 * 1024,
      }),
    ).rejects.toThrow(/maxMessageSize/);
  });

  it("oversized host message is rejected synchronously", async () => {
    const { session } = await fresh();
    expect(() => session.send("x".repeat(70 * 1024))).toThrow(/maxMessageSize/);
  });

  it("total output cap stops a chatty guest", async () => {
    const { session } = await fresh();
    await expect(
      session.run(
        `for (let i = 0; i < 100; i++) { host.send("0123456789".repeat(100)); } "done"`,
        { maxTotalOutputBytes: 10 * 1024 },
      ),
    ).rejects.toThrow(/maxTotalOutputBytes/);
  });

  it("outstanding ask cap stops ask spam", async () => {
    const { session } = await fresh();
    session.registerAsk("slow", () => new Promise(() => undefined as never));
    await expect(
      session.run(
        `const ps = []; for (let i = 0; i < 20; i++) { ps.push(host.ask("slow")); } "done"`,
        { maxOutstandingAsks: 4 },
      ),
    ).rejects.toThrow(/too many outstanding asks/);
  });
});

describe("watchdog", () => {
  it("a run whose ask never answers is killed by the watchdog, and the session fails closed", async () => {
    const { session } = await fresh();
    session.registerAsk("never", () => new Promise<string>(() => undefined));
    const start = Date.now();
    await expect(
      session.run(`(async () => { await host.ask("never"); })()`, {
        deadlineMs: 200,
      }),
    ).rejects.toThrow(/watchdog/);
    expect(Date.now() - start).toBeLessThan(3000);
    await expect(session.run(`"x"`)).rejects.toThrow(/session failed/);
  });
});

describe("malformed input", () => {
  it("garbage port messages are ignored and the next run still works", async () => {
    const { session, runner } = await fresh();
    runner.handleMessage("not json");
    runner.handleMessage(JSON.stringify({ t: "nope" }));
    runner.handleMessage(JSON.stringify({ t: "run", id: "x", code: 1 }));
    runner.handleMessage(42);
    await expect(session.run(`"still alive"`)).resolves.toBe("still alive");
  });
});

describe("leaks", () => {
  it("100 sequential runs leave no active run and no pending asks", async () => {
    const { session, runner } = await fresh();
    for (let i = 0; i < 100; i++) {
      const result = await session.run(`"run ${i}"`);
      expect(result).toBe(`run ${i}`);
      const stats = runner.stats();
      expect(stats.activeRun).toBe(false);
      expect(stats.pendingAsks).toBe(0);
    }
    expect(runner.stats().runsCompleted).toBe(100);
  });
});
