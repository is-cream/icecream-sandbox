import { describe, it, expect } from "vitest";
import {
  ConnectionGate,
  normalizeOrigin,
} from "../../src/connections.js";

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("normalizeOrigin", () => {
  it("accepts bare origins and normalizes default ports", () => {
    expect(normalizeOrigin("https://cdn.jsdelivr.net")).toBe("https://cdn.jsdelivr.net");
    expect(normalizeOrigin("https://example.com:443")).toBe("https://example.com");
    expect(normalizeOrigin("http://localhost:8902")).toBe("http://localhost:8902");
  });

  it("rejects paths, queries, hashes, and non-http(s) schemes", () => {
    expect(normalizeOrigin("https://example.com/path")).toBeNull();
    expect(normalizeOrigin("https://example.com/?q=1")).toBeNull();
    expect(normalizeOrigin("https://example.com/#x")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
  });
});

describe("ConnectionGate", () => {
  it("pre-allowed origins fetch without prompting", async () => {
    const seen: Array<{ url: string; init: unknown }> = [];
    const gate = new ConnectionGate({
      allowedOrigins: ["https://cdn.example"],
      fetchImpl: (async (url: unknown, init: unknown) => {
        seen.push({ url: String(url), init });
        return jsonResponse("body { color: red; }");
      }) as typeof fetch,
    });
    await expect(gate.fetchText("https://cdn.example/x.css")).resolves.toBe(
      "body { color: red; }",
    );
    expect(seen).toHaveLength(1);
    const init = seen[0]!.init as Record<string, unknown>;
    expect(init["method"]).toBe("GET");
    expect(init["credentials"]).toBe("omit");
    expect(init["redirect"]).toBe("manual");
  });

  it("unknown origins deny without a callback, and nothing is fetched", async () => {
    let fetched = false;
    const gate = new ConnectionGate({
      fetchImpl: (async () => {
        fetched = true;
        return jsonResponse("x");
      }) as typeof fetch,
    });
    await expect(gate.fetchText("https://evil.example/x")).rejects.toThrow(/not allowed/);
    expect(fetched).toBe(false);
  });

  it("allow-once prompts on every request", async () => {
    const prompts: string[] = [];
    const gate = new ConnectionGate({
      onRequest: (req) => {
        prompts.push(req.origin);
        return "allow-once";
      },
      fetchImpl: (async () => jsonResponse("ok")) as typeof fetch,
    });
    await gate.fetchText("https://a.example/1");
    await gate.fetchText("https://a.example/2");
    expect(prompts).toEqual(["https://a.example", "https://a.example"]);
    expect(gate.getGrants()).toEqual([]);
  });

  it("allow-session prompts once, then grants the origin", async () => {
    const prompts: string[] = [];
    const gate = new ConnectionGate({
      onRequest: (req) => {
        prompts.push(req.origin);
        return "allow-session";
      },
      fetchImpl: (async () => jsonResponse("ok")) as typeof fetch,
    });
    await gate.fetchText("https://a.example/1");
    await gate.fetchText("https://a.example/2");
    expect(prompts).toEqual(["https://a.example"]);
    expect(gate.getGrants()).toEqual(["https://a.example"]);
  });

  it("revoking a grant re-prompts", async () => {
    const prompts: string[] = [];
    const gate = new ConnectionGate({
      onRequest: (req) => {
        prompts.push(req.origin);
        return "allow-session";
      },
      fetchImpl: (async () => jsonResponse("ok")) as typeof fetch,
    });
    await gate.fetchText("https://a.example/1");
    expect(prompts).toEqual(["https://a.example"]);
    expect(gate.revokeGrant("https://a.example")).toBe(true);
    expect(gate.getGrants()).toEqual([]);
    await gate.fetchText("https://a.example/2");
    expect(prompts).toEqual(["https://a.example", "https://a.example"]);
    expect(gate.getGrants()).toEqual(["https://a.example"]);
  });

  it("deny blocks the fetch", async () => {
    let fetched = false;
    const gate = new ConnectionGate({
      onRequest: () => "deny",
      fetchImpl: (async () => {
        fetched = true;
        return jsonResponse("x");
      }) as typeof fetch,
    });
    await expect(gate.fetchText("https://a.example/1")).rejects.toThrow(/denied by user/);
    expect(fetched).toBe(false);
  });

  it("rejects invalid and non-http(s) URLs before prompting", async () => {
    const prompts: string[] = [];
    const gate = new ConnectionGate({
      onRequest: (req) => {
        prompts.push(req.origin);
        return "allow-once";
      },
      fetchImpl: (async () => jsonResponse("x")) as typeof fetch,
    });
    await expect(gate.fetchText("not a url")).rejects.toThrow(/invalid URL/);
    await expect(gate.fetchText("javascript:alert(1)")).rejects.toThrow(/only http/);
    await expect(gate.fetchText("file:///etc/passwd")).rejects.toThrow(/only http/);
    expect(prompts).toEqual([]);
  });

  it("a redirect response is rejected, never followed", async () => {
    const prompts: string[] = [];
    let fetches = 0;
    const gate = new ConnectionGate({
      onRequest: (req) => {
        prompts.push(req.origin);
        return "allow-once";
      },
      fetchImpl: (async (url: unknown) => {
        fetches += 1;
        if (String(url) === "https://a.example/old") return redirectResponse("https://b.example/new");
        return jsonResponse("should not arrive");
      }) as typeof fetch,
    });
    await expect(gate.fetchText("https://a.example/old")).rejects.toThrow(
      /redirects are not followed/,
    );
    // Only the initial approval happened; no hop was ever fetched.
    expect(prompts).toEqual(["https://a.example"]);
    expect(fetches).toBe(1);
  });

  it("an opaque-redirect response (the browser's form) is rejected the same way", async () => {
    const gate = new ConnectionGate({
      allowedOrigins: ["https://a.example"],
      fetchImpl: (async () =>
        ({
          type: "opaqueredirect",
          status: 0,
          ok: false,
          headers: new Headers(),
        }) as unknown as Response) as typeof fetch,
    });
    await expect(gate.fetchText("https://a.example/old")).rejects.toThrow(
      /redirects are not followed/,
    );
  });

  it("oversized bodies are rejected", async () => {
    const gate = new ConnectionGate({
      allowedOrigins: ["https://a.example"],
      maxResponseBytes: 100,
      fetchImpl: (async () => jsonResponse("x".repeat(1000))) as typeof fetch,
    });
    await expect(gate.fetchText("https://a.example/big")).rejects.toThrow(/exceeds/);
  });

  it("HTTP error statuses are rejected without returning the body", async () => {
    const gate = new ConnectionGate({
      allowedOrigins: ["https://a.example"],
      fetchImpl: (async () => jsonResponse("secret body", 403)) as typeof fetch,
    });
    await expect(gate.fetchText("https://a.example/no")).rejects.toThrow(/HTTP 403/);
  });

  it("a hanging fetch hits the timeout", async () => {
    const gate = new ConnectionGate({
      allowedOrigins: ["https://a.example"],
      timeoutMs: 50,
      fetchImpl: ((async (_url: unknown, init: unknown) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "TimeoutError";
            reject(error);
          });
        });
      }) as unknown) as typeof fetch,
    });
    await expect(gate.fetchText("https://a.example/slow")).rejects.toThrow(/timed out/);
  });

  it("bad allowedOrigins entries throw at construction", () => {
    expect(() => new ConnectionGate({ allowedOrigins: ["https://a.example/path"] })).toThrow(
      /not a bare/,
    );
    expect(() => new ConnectionGate({ allowedOrigins: ["notaurl"] })).toThrow(/not a bare/);
  });
});
