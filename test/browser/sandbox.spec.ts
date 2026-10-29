import { test, expect, type Page } from "@playwright/test";

const DEMO = "http://localhost:8901";
const CANARY = "http://localhost:8902";

async function readyHarness(page: Page) {
  await page.goto(`${DEMO}/harness.html`);
  await page.waitForFunction(() => (window as any).harnessReady === true);
  await page.evaluate(() => (window as any).harness.create());
}

test("guest runs in a blob worker inside the opaque-origin iframe", async ({ page }) => {
  await readyHarness(page);
  const result = await page.evaluate(() =>
    (window as any).harness.run(`host.send("hello"); "world"`),
  );
  expect(result).toBe("world");
  const messages = await page.evaluate(() => (window as any).harness.getMessages());
  expect(messages).toContain("hello");

  // The iframe itself must be opaque-origin and script-only sandboxed.
  const info = await page.evaluate(() => (window as any).harness.iframeInfo());
  expect(info.sandboxAttr).toBe("allow-scripts");
  expect(info.contentDocumentNull).toBe(true);
});

test("guest sees no network, DOM, or storage globals", async ({ page }) => {
  await readyHarness(page);
  const probe = [
    "fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "process",
    "require", "document", "window", "localStorage", "indexedDB",
    "navigator", "location",
  ];
  const code = `[${probe.map((n) => `"${n}"`).join(",")}].map((n) => n + "=" + (typeof globalThis[n])).join("; ") + "; host=" + (typeof host)`;
  const result = await page.evaluate((c) => (window as any).harness.run(c), code);
  for (const name of probe) {
    expect(result).toContain(`${name}=undefined`);
  }
  expect(result).toContain("host=object");
});

test("sandboxed iframe network attempts are blocked and the canary sees zero requests", async ({ page }) => {
  await page.goto(`${DEMO}/harness.html`);
  await page.waitForFunction(() => (window as any).harnessReady === true);
  await page.evaluate(async (canary) => {
    await fetch(`${canary}/__reset`);
  }, CANARY);

  // Load the probe page — served with the SAME CSP as the real iframe
  // document — inside a script-only sandboxed iframe, and collect its
  // report. The probe tries fetch, XHR, and WebSocket to the canary.
  const results = (await page.evaluate((demo) => {
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data && event.data.type === "canary-results") {
          window.removeEventListener("message", onMessage);
          resolve(event.data.results);
        }
      };
      window.addEventListener("message", onMessage);
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = `${demo}/canary-probe.html`;
      document.body.appendChild(frame);
    });
  }, DEMO)) as Record<string, unknown>;
  for (const key of ["fetch", "xhr", "ws"]) {
    expect(String(results[key])).toMatch(/blocked/);
    expect(String(results[key])).not.toContain("UNEXPECTED SUCCESS");
  }
  const log = await page.evaluate(async (canary) => {
    const res = await fetch(`${canary}/__log`);
    return res.json();
  }, CANARY);
  expect(log).toEqual([]);
});

test("messages from the wrong source or with the wrong nonce are ignored", async ({ page }) => {
  await readyHarness(page);
  await page.evaluate(() => (window as any).harness.postWrongNonceWatchdog());
  await page.evaluate(() => (window as any).harness.postFromAttacker());
  // The session must be untouched: the next run still works.
  const result = await page.evaluate(() =>
    (window as any).harness.run(`"still alive"`),
  );
  expect(result).toBe("still alive");
});

test.describe("gated connections", () => {
  async function readyConnection(
    page: Page,
    opts: { allowedOrigins?: string[]; autoDecision?: string | null },
  ) {
    await page.goto(`${DEMO}/harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    await page.evaluate(
      (o: { allowedOrigins?: string[]; autoDecision?: string | null }) =>
        (window as any).harness.createConnection(o),
      opts,
    );
  }

  test("pre-allowed origin fetches host-side", async ({ page }) => {
    await readyConnection(page, { allowedOrigins: [CANARY], autoDecision: null });
    const result = await page.evaluate(
      (canary) =>
        (window as any).harness.run(
          `(async () => { return await host.fetchText("${canary}/style.css"); })()`,
        ),
      CANARY,
    );
    expect(result).toBe("canary");
    const log = await page.evaluate(async (canary) => {
      const res = await fetch(`${canary}/__log`);
      return res.json();
    }, CANARY);
    expect(log.some((entry: { url: string }) => entry.url === "/style.css")).toBe(true);
  });

  test("unknown origin denies by default and nothing is fetched", async ({ page }) => {
    await readyConnection(page, { autoDecision: null });
    await expect(
      page.evaluate(
        (canary) =>
          (window as any).harness.run(
            `(async () => { await host.fetchText("${canary}/x"); })()`,
          ),
        CANARY,
      ),
    ).rejects.toThrow(/not allowed/);
  });

  test("allow-session prompts once and grants the origin", async ({ page }) => {
    await readyConnection(page, { autoDecision: "allow-session" });
    const run = (canary: string) =>
      page.evaluate(
        (c) =>
          (window as any).harness.run(
            `(async () => { return await host.fetchText("${c}/a"); })()`,
          ),
        canary,
      );
    await run(CANARY);
    await run(CANARY);
    const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
    expect(prompts).toEqual([CANARY]);
    const grants = await page.evaluate(() => (window as any).harness.getGrants());
    expect(grants).toEqual([CANARY]);
  });

  test("allow-once prompts on every request", async ({ page }) => {
    await readyConnection(page, { autoDecision: "allow-once" });
    const run = (canary: string) =>
      page.evaluate(
        (c) =>
          (window as any).harness.run(
            `(async () => { return await host.fetchText("${c}/a"); })()`,
          ),
        canary,
      );
    await run(CANARY);
    await run(CANARY);
    const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
    expect(prompts).toEqual([CANARY, CANARY]);
  });

  test("user deny blocks the fetch", async ({ page }) => {
    await readyConnection(page, { autoDecision: "deny" });
    await expect(
      page.evaluate(
        (canary) =>
          (window as any).harness.run(
            `(async () => { await host.fetchText("${canary}/x"); })()`,
          ),
        CANARY,
      ),
    ).rejects.toThrow(/denied by user/);
  });

  test("revoking a grant re-prompts", async ({ page }) => {
    await readyConnection(page, { autoDecision: "allow-session" });
    await page.evaluate(
      (canary) =>
        (window as any).harness.run(
          `(async () => { return await host.fetchText("${canary}/a"); })()`,
        ),
      CANARY,
    );
    await page.evaluate(
      (canary) => (window as any).harness.revokeGrant(canary),
      CANARY,
    );
    await page.evaluate(
      (canary) =>
        (window as any).harness.run(
          `(async () => { return await host.fetchText("${canary}/a"); })()`,
        ),
      CANARY,
    );
    const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
    expect(prompts).toEqual([CANARY, CANARY]);
  });

  test("a redirect is rejected, never followed", async ({ page }) => {
    // The canary redirects localhost -> 127.0.0.1 (a different origin).
    // The gate rejects the redirect outright: only the initial origin was
    // ever prompted, and the redirect target was never fetched.
    await readyConnection(page, { autoDecision: "allow-session" });
    await expect(
      page.evaluate(
        (canary) =>
          (window as any).harness.run(
            `(async () => { await host.fetchText("${canary}/__redirect"); })()`,
          ),
        CANARY,
      ),
    ).rejects.toThrow(/redirects are not followed/);
    const prompts = await page.evaluate(() => (window as any).harness.getPrompts());
    expect(prompts).toEqual([CANARY]);
    const log = await page.evaluate(async (canary) => {
      const res = await fetch(`${canary}/__log`);
      return res.json();
    }, CANARY);
    expect(log.some((entry: { url: string }) => entry.url === "/ping")).toBe(false);
  });

  test("oversized responses are rejected", async ({ page }) => {
    await readyConnection(page, { allowedOrigins: [CANARY], autoDecision: null });
    await expect(
      page.evaluate(
        (canary) =>
          (window as any).harness.run(
            `(async () => { await host.fetchText("${canary}/__big"); })()`,
          ),
        CANARY,
      ),
    ).rejects.toThrow(/exceeds/);
  });

  test("the guest cannot read the host-held allowlist or grants", async ({ page }) => {
    await readyConnection(page, { allowedOrigins: [CANARY], autoDecision: null });
    const result = await page.evaluate(() =>
      (window as any).harness.run(
        `"fetchText=" + (typeof host.fetchText) + ";grants=" + (typeof host.getConnectionGrants) + ";allowed=" + (typeof host.allowedOrigins)`,
      ),
    );
    expect(result).toContain("fetchText=function");
    expect(result).toContain("grants=undefined");
    expect(result).toContain("allowed=undefined");
  });
});

test.describe("guest rendering", () => {
  const counterCode = `
    let count = 0;
    function render() {
      return JSON.stringify({ kind: "render", tree: { type: "div", children: [
        { type: "p", children: ["count: " + count] },
        { type: "button", props: { onClick: "inc" }, children: ["+1"] }
      ]}});
    }
    globalThis.onMessage = function (m) {
      const msg = JSON.parse(m);
      if (msg.kind === "event" && msg.id === "inc") { count++; host.send(render()); }
    };
    host.send(render());
    "ready"
  `;

  test("guest counter renders, clicks round-trip, and re-renders", async ({ page }) => {
    await readyHarness(page);
    // A long-lived guest app keeps its run in flight (a promise that only
    // settles when the app ends), so onMessage keeps working across events.
    // The evaluate must NOT await the run promise, or it would hang.
    await page.evaluate(
      (code) => {
        void (window as any).harness.run(code, { deadlineMs: 30000 });
      },
      counterCode + "\nnew Promise(() => {})",
    );
    await page.waitForFunction(
      () => (window as any).harness.getMessages().length >= 1,
    );
    await page.evaluate(() => {
      const tree = JSON.parse((window as any).harness.getMessages()[0]).tree;
      (window as any).harness.renderApp(tree);
    });
    expect(await page.evaluate(() => (window as any).harness.getShadowText())).toContain(
      "count: 0",
    );
    await page.evaluate(() => (window as any).harness.clickShadow("button"));
    const events = await page.evaluate(() => (window as any).harness.getEvents());
    expect(events).toEqual([{ id: "inc", value: undefined }]);
    await page.evaluate(() =>
      (window as any).harness.send(JSON.stringify({ kind: "event", id: "inc" })),
    );
    await page.waitForFunction(
      () => (window as any).harness.getMessages().length >= 2,
    );
    await page.evaluate(() => {
      const tree = JSON.parse((window as any).harness.getMessages()[1]).tree;
      (window as any).harness.renderApp(tree);
    });
    expect(await page.evaluate(() => (window as any).harness.getShadowText())).toContain(
      "count: 1",
    );
  });

  test("a link with an onClick id does not navigate; the host decides", async ({ page }) => {
    await readyHarness(page);
    await page.evaluate(() => {
      (window as any).harness.renderApp({
        type: "div",
        children: [
          {
            type: "a",
            props: { href: "https://example.com/", onClick: "open-example" },
            children: ["example"],
          },
        ],
      });
    });
    await page.evaluate(() => (window as any).harness.clickShadow("a"));
    const events = await page.evaluate(() => (window as any).harness.getEvents());
    expect(events).toEqual([{ id: "open-example", value: undefined }]);
    // Still on the harness page: the click did not navigate.
    expect(page.url()).toContain("/harness.html");
  });

  test("CDN CSS flows through the gate, is sanitized, and styles the app", async ({ page }) => {
    await page.goto(`${DEMO}/harness.html`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    await page.evaluate(() =>
      (window as any).harness.createConnection({ allowedOrigins: ["http://localhost:8902"] }),
    );
    const code = `
      (async () => {
        const css = await host.fetchText("http://localhost:8902/theme.css");
        host.send(JSON.stringify({ kind: "render",
          tree: { type: "div", children: [{ type: "p", children: ["styled"] }] },
          css: css }));
        return "sent";
      })()
    `;
    await page.evaluate((c) => (window as any).harness.run(c), code);
    await page.waitForFunction(
      () => (window as any).harness.getMessages().length >= 1,
    );
    await page.evaluate(() => {
      const msg = JSON.parse((window as any).harness.getMessages()[0]);
      (window as any).harness.renderApp(msg.tree, msg.css);
    });
    const style = await page.evaluate(() => (window as any).harness.getShadowStyle());
    expect(style).toContain("rgb(1, 2, 3)");
    expect(style).not.toContain("evil.example");
    expect(style).not.toContain("@import");
    expect(style).not.toContain("url(");
    const color = await page.evaluate(() =>
      (window as any).harness.getShadowComputedColor("p"),
    );
    expect(color).toBe("rgb(1, 2, 3)");
  });
});

test("watchdog kills a hung worker and the next run rebuilds the session", async ({ page }) => {
  await readyHarness(page);
  await page.evaluate(() => (window as any).harness.registerAskNever());
  await expect(
    page.evaluate(() =>
      (window as any).harness.run(
        `(async () => { await host.ask("never"); })()`,
        { deadlineMs: 200 },
      ),
    ),
  ).rejects.toThrow(/watchdog/);
  // A fresh session (new worker, new handshake) serves the next run.
  const result = await page.evaluate(() =>
    (window as any).harness.run(`"rebuilt"`),
  );
  expect(result).toBe("rebuilt");
});
