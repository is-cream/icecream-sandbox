/**
 * Security suite (browser half): attacks that need a real page, iframe,
 * worker, and network. Each test tries something a hostile guest might
 * try and asserts it fails — and, where a network request would prove a
 * bypass, that the canary server recorded nothing.
 *
 * The unit half lives in test/security/attack.test.ts.
 */
import { test, expect, type Page } from "@playwright/test";

const DEMO = "http://localhost:8901";
const CANARY = "http://localhost:8902";

async function readyHarness(page: Page) {
  await page.goto(`${DEMO}/harness.html`);
  await page.waitForFunction(() => (window as any).harnessReady === true);
  await page.evaluate(() => (window as any).harness.create());
}

async function resetCanary() {
  await fetch(`${CANARY}/__reset`);
}

async function canaryLog() {
  const res = await fetch(`${CANARY}/__log`);
  return res.json();
}

test.describe("security: guest escape attempts", () => {
  test("fetch, XHR, and WebSocket attempts throw (no such globals)", async ({ page }) => {
    await readyHarness(page);
    await expect(
      page.evaluate(() =>
        (window as any).harness.run(`fetch("http://localhost:8902/x")`),
      ),
    ).rejects.toThrow(/fetch/);
    await expect(
      page.evaluate(() => (window as any).harness.run(`new XMLHttpRequest()`)),
    ).rejects.toThrow(/XMLHttpRequest/);
    await expect(
      page.evaluate(() => (window as any).harness.run(`new WebSocket("ws://x")`)),
    ).rejects.toThrow(/WebSocket/);
  });

  test("window, parent, and document are unreachable", async ({ page }) => {
    await readyHarness(page);
    await expect(
      page.evaluate(() => (window as any).harness.run(`window.top`)),
    ).rejects.toThrow(/window/);
    await expect(
      page.evaluate(() => (window as any).harness.run(`parent.postMessage("hi", "*")`)),
    ).rejects.toThrow(/parent/);
    await expect(
      page.evaluate(() => (window as any).harness.run(`document.cookie`)),
    ).rejects.toThrow(/document/);
  });

  test("attack attempts produce zero canary requests", async ({ page }) => {
    await readyHarness(page);
    await resetCanary();
    const attempts = [
      `fetch("http://localhost:8902/pixel")`,
      `new XMLHttpRequest()`,
      `(async () => { await host.fetchText("http://localhost:8902/pixel"); })()`,
    ];
    for (const code of attempts) {
      await expect(
        page.evaluate((c) => (window as any).harness.run(c), code),
      ).rejects.toThrow(/./);
    }
    expect(await canaryLog()).toEqual([]);
  });
});

test.describe("security: render attacks", () => {
  test("markup strings stay text, never elements", async ({ page }) => {
    await readyHarness(page);
    await page.evaluate(() => {
      (window as any).harness.renderApp({
        type: "div",
        children: ["<img src=x onerror=alert(1)>"],
      });
    });
    const html = await page.evaluate(() => (window as any).harness.getShadowHtml());
    expect(html).toContain("&lt;img");
    expect(
      await page.evaluate(() => (window as any).harness.shadowHas("img")),
    ).toBe(false);
  });

  test("script, iframe, form, and style trees are rejected before DOM", async ({ page }) => {
    await readyHarness(page);
    for (const type of ["script", "iframe", "form", "style"]) {
      await expect(
        page.evaluate(
          (t) => (window as any).harness.renderApp({ type: t, children: ["x"] }),
          type,
        ),
      ).rejects.toThrow(/disallowed/);
    }
    expect(await page.evaluate(() => (window as any).harness.getShadowHtml())).toBe("");
  });

  test("remote image sources are dropped, so no request is made", async ({ page }) => {
    await readyHarness(page);
    await resetCanary();
    await page.evaluate(
      (canary) => {
        (window as any).harness.renderApp({
          type: "div",
          children: [{ type: "img", props: { src: `${canary}/pixel` } }],
        });
      },
      CANARY,
    );
    // The img element exists but carries no src: nothing was fetched.
    expect(await page.evaluate(() => (window as any).harness.shadowHas("img"))).toBe(true);
    const html = await page.evaluate(() => (window as any).harness.getShadowHtml());
    expect(html).not.toContain("/pixel");
    expect(await canaryLog()).toEqual([]);
  });

  test("javascript: hrefs are dropped, https hrefs are kept", async ({ page }) => {
    await readyHarness(page);
    await page.evaluate(() => {
      (window as any).harness.renderApp({
        type: "div",
        children: [
          { type: "a", props: { href: "javascript:alert(1)" }, children: ["bad"] },
          { type: "a", props: { href: "https://example.com/" }, children: ["good"] },
        ],
      });
    });
    const html = await page.evaluate(() => (window as any).harness.getShadowHtml());
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://example.com/");
  });

  test("style object url() values are neutralized", async ({ page }) => {
    await readyHarness(page);
    await page.evaluate(() => {
      (window as any).harness.renderApp({
        type: "div",
        props: { style: { backgroundImage: "url(https://evil.example/x.png)" } },
        children: ["styled"],
      });
    });
    const html = await page.evaluate(() => (window as any).harness.getShadowHtml());
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("url(");
  });

  test("stylesheet traps are stripped in the real flow", async ({ page }) => {
    await readyHarness(page);
    await page.evaluate(() => {
      (window as any).harness.renderApp(
        { type: "p", children: ["styled"] },
        "p { color: red; } @import url(\"https://evil.example/a.css\"); " +
          "div { background-image: url(\"https://evil.example/p.png\"); }",
      );
    });
    const style = await page.evaluate(() => (window as any).harness.getShadowStyle());
    expect(style).toContain("color: red");
    expect(style).not.toContain("evil.example");
    expect(style).not.toContain("@import");
    expect(style).not.toContain("url(");
  });

  test("__proto__ props do not pollute the host", async ({ page }) => {
    await readyHarness(page);
    // Trees are built via JSON.parse: an object literal {"__proto__": ...}
    // would set the prototype instead of creating an own property, which
    // would test nothing. JSON.parse creates a real own property.
    await page.evaluate(() => {
      (window as any).harness.renderApp(
        JSON.parse('{"type":"div","props":{"__proto__":"x"},"children":["ok"]}'),
      );
    });
    expect(await page.evaluate(() => (window as any).harness.getShadowText())).toContain("ok");
    const polluted = await page.evaluate(
      () => (Object.prototype as Record<string, unknown>)["polluted"],
    );
    expect(polluted).toBeUndefined();
    // An object-valued prop is rejected outright by validation.
    await expect(
      page.evaluate(() =>
        (window as any).harness.renderApp(
          JSON.parse(
            '{"type":"div","props":{"__proto__":{"polluted":true}},"children":["x"]}',
          ),
        ),
      ),
    ).rejects.toThrow();
  });
});

test.describe("security: gate attacks", () => {
  test("the guest cannot read the allowlist or the grants", async ({ page }) => {
    await page.goto(`${DEMO}/harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    await page.evaluate(
      (canary) => (window as any).harness.createConnection({ allowedOrigins: [canary] }),
      CANARY,
    );
    const result = await page.evaluate(() =>
      (window as any).harness.run(
        `"grants=" + (typeof host.getConnectionGrants) + ";allowed=" + (typeof host.allowedOrigins)`,
      ),
    );
    expect(result).toContain("grants=undefined");
    expect(result).toContain("allowed=undefined");
  });

  test("non-http(s) fetches are denied before any prompt", async ({ page }) => {
    await page.goto(`${DEMO}/harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    await page.evaluate(() => (window as any).harness.createConnection({ autoDecision: "allow-session" }));
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      await expect(
        page.evaluate(
          (u) => (window as any).harness.run(`(async () => { await host.fetchText("${u}"); })()`),
          url,
        ),
      ).rejects.toThrow(/only http/);
    }
    const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
    expect(prompts).toEqual([]);
  });
});
