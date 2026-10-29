/**
 * Security suite (unit half): attack-focused tests that run in Node
 * against the real embedded QuickJS build. Each test is an attack a
 * hostile guest might try, and asserts it fails without affecting the
 * host or the next run. The browser half (test/browser/security.spec.ts)
 * covers the attacks that need a real page, iframe, and network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPair, type Pair } from "../unit/harness.js";
import { ConnectionGate } from "../../src/connections.js";

let pair: Pair | null = null;

afterEach(() => {
  pair?.close();
  pair = null;
});

async function fresh(): Promise<Pair> {
  pair = await createPair();
  return pair;
}

describe("realm escape", () => {
  it("prototype pollution stays inside the guest realm", async () => {
    const { session } = await fresh();
    await session.run(`Object.prototype.polluted = "yes"; "done"`);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
    // And the next run gets a fresh realm, not the polluted one.
    const check = await session.run(`typeof Object.prototype.polluted`);
    expect(check).toBe("undefined");
  });

  it("constructor escape attempt fails and the next run still works", async () => {
    const { session } = await fresh();
    await expect(
      session.run(`({}).constructor.constructor("return process")()`),
    ).rejects.toThrow(/process/);
    await expect(session.run(`"still alive"`)).resolves.toBe("still alive");
  });

  it("JSON __proto__ keys in guest messages do not pollute the host", async () => {
    const { session } = await fresh();
    const received: string[] = [];
    session.on("message", (message) => {
      received.push(message);
    });
    await session.run(`host.send('{"__proto__":{"polluted":true}}'); "done"`);
    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]!);
    expect(parsed["__proto__"]).toEqual({ polluted: true });
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect({}.hasOwnProperty("polluted")).toBe(false);
  });
});

describe("host bridge abuse", () => {
  it("host.send with a non-string throws inside the guest", async () => {
    const { session } = await fresh();
    await expect(session.run(`host.send({ evil: true }); "done"`)).rejects.toThrow(
      /host\.send: argument must be a string/,
    );
  });

  it("host.send over maxMessageSize throws inside the guest", async () => {
    const { session } = await fresh();
    await expect(
      session.run(`host.send("x".repeat(70000)); "done"`, { maxMessageSize: 64 * 1024 }),
    ).rejects.toThrow(/exceeds maxMessageSize/);
  });

  it("total output cap stops a message flood", async () => {
    const { session } = await fresh();
    await expect(
      session.run(
        `for (let i = 0; i < 20; i++) { host.send("x".repeat(60000)); } "done"`,
        { maxTotalOutputBytes: 1024 * 1024 },
      ),
    ).rejects.toThrow(/maxTotalOutputBytes/);
  });

  it("unregistered ask names reject, including __proto__", async () => {
    const { session } = await fresh();
    await expect(
      session.run(`(async () => { await host.ask("nope", "x"); })()`),
    ).rejects.toThrow(/not registered/);
    await expect(
      session.run(`(async () => { await host.ask("__proto__", "x"); })()`),
    ).rejects.toThrow(/not registered/);
  });

  it("an ask handler returning a non-string is reported, not delivered", async () => {
    const { session } = await fresh();
    session.registerAsk("bad", () => 42 as unknown as string);
    await expect(
      session.run(`(async () => { await host.ask("bad", "x"); })()`),
    ).rejects.toThrow(/non-string/);
  });

  it("oversized code is rejected before running", async () => {
    const { session } = await fresh();
    // The code string itself (a 2 MiB literal) exceeds the cap; nothing runs.
    const bigCode = `"${"x".repeat(2 * 1024 * 1024)}"`;
    await expect(session.run(bigCode, { maxCodeSize: 1024 * 1024 })).rejects.toThrow(
      /maxCodeSize/,
    );
  });
});

describe("gated connection abuse", () => {
  it("javascript:, file:, and data: URLs are rejected before any prompt", async () => {
    const { session } = await fresh();
    const prompts: string[] = [];
    const gate = new ConnectionGate({
      onRequest: (req) => {
        prompts.push(req.origin);
        return "allow-session";
      },
      fetchImpl: (async () => new Response("x")) as typeof fetch,
    });
    session.onConnectionRequest = (url) => gate.fetchText(url);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>"]) {
      await expect(
        session.run(`(async () => { await host.fetchText(${JSON.stringify(url)}); })()`),
      ).rejects.toThrow(/only http/);
    }
    expect(prompts).toEqual([]);
  });

  it("a 70 KiB URL is rejected by the guest-side message cap", async () => {
    const { session } = await fresh();
    session.onConnectionRequest = async () => "x";
    await expect(
      session.run(
        `(async () => { await host.fetchText("https://a.example/" + "x".repeat(70000)); })()`,
      ),
    ).rejects.toThrow(/maxMessageSize/);
  });

  it("the gate denies with no callback even when the guest begs", async () => {
    const { session } = await fresh();
    const gate = new ConnectionGate({
      fetchImpl: (async () => new Response("x")) as typeof fetch,
    });
    session.onConnectionRequest = (url) => gate.fetchText(url);
    await expect(
      session.run(`(async () => { await host.fetchText("https://a.example/x"); })()`),
    ).rejects.toThrow(/not allowed/);
  });
});
