/**
 * Browser end-to-end tests for the transparent host<->guest bridge:
 * the guest calls host-configured globals like normal APIs, the host
 * invokes guest functions by dotted path, and a guest-built UI actually
 * renders in the host page. Real Sandbox, real iframe, real worker.
 */
import { test, expect, type Page } from "@playwright/test";

const DEMO = "http://localhost:8901";

async function readyBridge(page: Page) {
  await page.goto(`${DEMO}/harness.html`);
  await page.waitForFunction(() => (window as any).harnessReady === true);
  await page.evaluate(() => (window as any).harness.createBridge());
}

const GUEST_CODE = `(async () => {
  // Guest -> host: plain API calls, no host object in sight.
  const note = await notify("ping");
  await kv.set("user", "ada");
  const user = await kv.get("user");
  // Host -> guest: plain globals the host may invoke by dotted path.
  globalThis.renderCard = function (arg) { return "card:" + arg + ":" + note; };
  globalThis.widgets = {
    count: 0,
    counter: function (n) { this.count += 1; return "count=" + this.count + ":" + n; },
  };
  // Tell the host about the user through the render path, then park.
  host.send(JSON.stringify({ kind: "render", tree: { type: "div", children: ["hi " + user] } }));
  let release;
  const gate = new Promise((res) => { release = res; });
  globalThis.onMessage = (m) => { if (m === "stop") release("finished"); };
  host.send("up");
  await gate;
  return "finished";
})()`;

test("end to end: guest calls host globals, host invokes guest functions, UI renders", async ({
  page,
}) => {
  await readyBridge(page);

  const outcome = await page.evaluate(async (code) => {
    const h = (window as any).harness;
    const runPromise = h.run(code);
    // Wait until the guest signals it is parked and ready.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        if (h.getMessages().includes("up") || h.getErrors().length > 0) {
          clearInterval(timer);
          resolve(null);
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("guest never signaled up"));
        }
      }, 25);
    });
    const errors = h.getErrors();
    if (errors.length > 0) return { errors };

    // Host -> guest: top-level and dotted-path invocations.
    const card = await h.invoke("renderCard", "R1");
    const c1 = await h.invoke("widgets.counter", "x");
    const c2 = await h.invoke("widgets.counter", "y");
    let disallowed = "";
    try {
      await h.invoke("evil", "");
    } catch (e) {
      disallowed = String((e as Error).message);
    }

    // Release the parked run.
    h.send("stop");
    const result = await runPromise;
    return {
      card,
      c1,
      c2,
      disallowed,
      result,
      bridgeCalls: h.getBridgeCalls(),
      messages: h.getMessages(),
    };
  }, GUEST_CODE);

  expect(outcome.errors ?? []).toEqual([]);

  // Guest -> host: the host saw every bridged call with its arguments.
  expect(outcome.bridgeCalls).toEqual([
    { path: "notify", args: ["ping"] },
    { path: "kv.set", args: ["user", "ada"] },
    { path: "kv.get", args: ["user"] },
  ]);

  // Host -> guest: invocations resolved, dotted path kept `this` state.
  expect(outcome.card).toBe("card:R1:notified:ping");
  expect(outcome.c1).toBe("count=1:x");
  expect(outcome.c2).toBe("count=2:y");
  expect(outcome.disallowed).toMatch(/not allowed/);
  expect(outcome.result).toBe("finished");

  // The guest-built UI actually renders in the host page.
  const renderMsg = outcome.messages.find(
    (m: string) => typeof m === "string" && m.includes('"kind":"render"'),
  );
  expect(renderMsg).toBeDefined();
  const tree = JSON.parse(renderMsg).tree;
  await page.evaluate((t) => (window as any).harness.renderApp(t), tree);
  expect(await page.evaluate(() => (window as any).harness.getShadowText())).toContain("hi ada");
});

test("an unconfigured global is a ReferenceError in the real stack", async ({ page }) => {
  await readyBridge(page);
  const result = await page.evaluate(() =>
    (window as any).harness.run(
      `(async () => { try { localStorage.setItem("k", "v"); } catch (e) { return e.name; } return "no-throw"; })()`,
    ),
  );
  // The harness only configured `kv`, not `localStorage`.
  expect(result).toBe("ReferenceError");
});

test("a bad bridge config fails at create time, never mid-run", async ({ page }) => {
  await page.goto(`${DEMO}/harness.html`);
  await page.waitForFunction(() => (window as any).harnessReady === true);
  const message = await page.evaluate(() => (window as any).harness.createBadGlobals());
  expect(message).toMatch(/must be a function/);
});
