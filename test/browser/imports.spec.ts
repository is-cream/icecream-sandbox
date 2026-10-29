/**
 * Browser tests for guest ES module imports: the full host path —
 * import map -> gate approval -> download -> cache -> real QuickJS
 * module evaluation — against the canary server, which records every
 * request so caching can be proven by request counts, not by trust.
 */
import { test, expect, type Page } from "@playwright/test";

const DEMO = "http://localhost:8901";
const CANARY = "http://localhost:8902";

async function readyImport(
  page: Page,
  opts: { allowedOrigins?: string[]; autoDecision?: string | null },
) {
  await page.goto(`${DEMO}/harness.html`);
  await page.waitForFunction(() => (window as any).harnessReady === true);
  await page.evaluate(
    (o: { allowedOrigins?: string[]; autoDecision?: string | null }) =>
      (window as any).harness.createImport(o),
    opts,
  );
}

async function canaryLog(page: Page) {
  return page.evaluate(async (canary) => {
    const res = await fetch(`${canary}/__log`);
    return res.json();
  }, CANARY);
}

async function resetCanary(page: Page) {
  await page.evaluate(async (canary) => {
    await fetch(`${canary}/__reset`);
  }, CANARY);
}

test("guest imports the real d3-format through one HITL approval", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await resetCanary(page);
  await page.evaluate(
    (canary) => (window as any).harness.runWithImports(
      `import { format } from 'd3-format';\n host.send(format('.2f')(3.14159));`,
      { deadlineMs: 10000 },
      { "d3-format": `${canary}/d3-format.mjs` },
    ),
    CANARY,
  );
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages).toContain("3.14");
  // Exactly one approval prompt, for the canary origin.
  const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([CANARY]);
  // Exactly one download of the real package.
  const log = await canaryLog(page);
  expect(log.filter((e: { url: string }) => e.url === "/d3-format.mjs")).toHaveLength(1);
});

test("second import is cached: zero new fetches, zero new prompts", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await resetCanary(page);
  const run = (canary: string) =>
    page.evaluate(
      (c) => (window as any).harness.runWithImports(
        `import { format } from 'd3-format';\n host.send(format('.0f')(42));`,
        { deadlineMs: 10000 },
        { "d3-format": `${c}/d3-format.mjs` },
      ),
      canary,
    );
  await run(CANARY);
  await run(CANARY);
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages.filter((m: string) => m === "42")).toHaveLength(2);
  // One prompt total (first run only) and one download total: the second
  // import came from the host-side cache, not the network.
  const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([CANARY]);
  const log = await canaryLog(page);
  expect(log.filter((e: { url: string }) => e.url === "/d3-format.mjs")).toHaveLength(1);
  const cache = await page.evaluate(() => (window as any).harness.getImportCache());
  expect(cache).toEqual([`${CANARY}/d3-format.mjs`]);
});

test("deny blocks the import and nothing is fetched", async ({ page }) => {
  await readyImport(page, { autoDecision: "deny" });
  await resetCanary(page);
  await expect(
    page.evaluate(
      (canary) => (window as any).harness.runWithImports(
        `import { format } from 'd3-format';\n host.send("never");`,
        { deadlineMs: 10000 },
        { "d3-format": `${canary}/d3-format.mjs` },
      ),
      CANARY,
    ),
  ).rejects.toThrow(/connection denied by user/);
  const log = await canaryLog(page);
  expect(log.filter((e: { url: string }) => e.url === "/d3-format.mjs")).toHaveLength(0);
});

test("unknown specifier fails naming the specifier", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await expect(
    page.evaluate(
      () => (window as any).harness.runWithImports(
        `import { x } from 'nope';\n host.send("never");`,
        { deadlineMs: 10000 },
        {},
      ),
    ),
  ).rejects.toThrow(/unknown import "nope"/);
});

test("transitive relative imports resolve against the importing module", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await resetCanary(page);
  await page.evaluate(
    (canary) => (window as any).harness.runWithImports(
      `import { format } from 'wrapper';\n host.send(format(',.0f')(1234567));`,
      { deadlineMs: 10000 },
      { wrapper: `${canary}/mod-wrapper.mjs` },
    ),
    CANARY,
  );
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages).toContain("1,234,567");
  const log = await canaryLog(page);
  expect(log.some((e: { url: string }) => e.url === "/mod-wrapper.mjs")).toBe(true);
  expect(log.some((e: { url: string }) => e.url === "/d3-format.mjs")).toBe(true);
});

test("imported module code has no more power than classic guest code", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await page.evaluate(
    (canary) => (window as any).harness.runWithImports(
      `import { format } from 'd3-format';\n` +
        `host.send(["fetch", "document", "window", "localStorage", "navigator"].map((n) => n + "=" + (typeof globalThis[n])).join("; ") + "; format=" + (typeof format));`,
      { deadlineMs: 10000 },
      { "d3-format": `${canary}/d3-format.mjs` },
    ),
    CANARY,
  );
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  const probe = messages.find((m: string) => m.includes("fetch="));
  expect(probe).toContain("fetch=undefined");
  expect(probe).toContain("document=undefined");
  expect(probe).toContain("window=undefined");
  expect(probe).toContain("localStorage=undefined");
  expect(probe).toContain("navigator=undefined");
  expect(probe).toContain("format=function");
});

test("every transitive hop is gated on its own origin", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await resetCanary(page);
  await page.evaluate(
    (canary) => (window as any).harness.runWithImports(
      `import { format } from 'xwrapper';\n host.send(format('.1f')(2.25));`,
      { deadlineMs: 10000 },
      { xwrapper: `${canary}/x-wrapper.mjs` },
    ),
    CANARY,
  );
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages).toContain("2.3");
  // Two prompts: one per origin, even though the second hop was reached
  // transitively from the first module. A grant never carries across.
  const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([CANARY, "http://127.0.0.1:8902"]);
});

test("downloaded, then re-rendered: lazy import resolves and the guest continues", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await resetCanary(page);
  await page.evaluate(
    (canary) => (window as any).harness.runWithImports(
      `(async () => {
         host.send("loading…");
         const { format } = await import('d3-format');
         host.send("formatted: " + format('.0f')(42));
         return "done";
       })()`,
      { deadlineMs: 10000 },
      { "d3-format": `${canary}/d3-format.mjs` },
    ),
    CANARY,
  );
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages).toEqual(["loading…", "formatted: 42"]);
  const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([CANARY]);
  const log = await canaryLog(page);
  expect(log.filter((e: { url: string }) => e.url === "/d3-format.mjs")).toHaveLength(1);
});

test("second dynamic import is cached: zero new fetches, zero new prompts", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await resetCanary(page);
  const run = (canary: string) =>
    page.evaluate(
      (c) => (window as any).harness.runWithImports(
        `(async () => {
           const { format } = await import('d3-format');
           host.send(format('.0f')(7));
           return "done";
         })()`,
        { deadlineMs: 10000 },
        { "d3-format": `${c}/d3-format.mjs` },
      ),
      canary,
    );
  await run(CANARY);
  await run(CANARY);
  const log = await canaryLog(page);
  expect(log.filter((e: { url: string }) => e.url === "/d3-format.mjs")).toHaveLength(1);
  const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([CANARY]);
});

test("host.importModule downloads lazily at call time, not at run start", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await resetCanary(page);
  // Start the run without awaiting it: the guest waits for a host
  // message before importing, so the prompt must still be absent
  // while it waits — proving the download happens at call time.
  await page.evaluate(
    (canary) => {
      (window as any).__run = (window as any).harness.runWithImports(
        `(async () => {
           host.send("ready");
           await new Promise((r) => { globalThis.onMessage = () => r(); });
           const mod = await host.importModule('d3-format');
           host.send(mod.format('.1f')(2.25));
           return "done";
         })()`,
        { deadlineMs: 10000 },
        { "d3-format": `${canary}/d3-format.mjs` },
      );
    },
    CANARY,
  );
  await page.waitForFunction(
    () => (window as any).harness.getMessages().includes("ready"),
  );
  let prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([]);
  await page.evaluate(() => (window as any).harness.send("go"));
  const result = await page.evaluate(() => (window as any).__run);
  expect(result).toBe("done");
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages).toContain("2.3");
  prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([CANARY]);
});

test("host.importModule rejects unknown names", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await expect(
    page.evaluate(
      (canary) => (window as any).harness.runWithImports(
        `(async () => { await host.importModule('evil'); })()`,
        { deadlineMs: 10000 },
        { "d3-format": `${canary}/d3-format.mjs` },
      ),
      CANARY,
    ),
  ).rejects.toThrow(/unknown import "evil"/);
});

test("computed import() of an unfetched module fails naming it", async ({ page }) => {
  await readyImport(page, { autoDecision: "allow-session" });
  await expect(
    page.evaluate(
      (canary) => (window as any).harness.runWithImports(
        `(async () => {
           const name = 'd3-format';
           await import(name);
         })()`,
        { deadlineMs: 10000 },
        { "d3-format": `${canary}/d3-format.mjs` },
      ),
      CANARY,
    ),
  ).rejects.toThrow(/could not load module 'd3-format'/);
});

test("pre-allowed origin imports with zero prompts", async ({ page }) => {
  await readyImport(page, { allowedOrigins: [CANARY], autoDecision: null });
  await page.evaluate(
    (canary) => (window as any).harness.runWithImports(
      `import { format } from 'd3-format';\n host.send(format('.1f')(2.25));`,
      { deadlineMs: 10000 },
      { "d3-format": `${canary}/d3-format.mjs` },
    ),
    CANARY,
  );
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages).toContain("2.3");
  const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
  expect(prompts).toEqual([]);
});
