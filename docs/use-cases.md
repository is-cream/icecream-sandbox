# icecream-sandbox: use cases

Who this library is for, what each use case looks like in code, and
where the edges are. All sketches use the public API from the README;
`iframeUrl` is assumed configured (see README, "Serving the iframe
document").

## 1. Run untrusted code a user pasted

The classic case: a playground, a code snippet in a forum post, a
formula a user typed. You want the result, not the risk.

```ts
const sandbox = await Sandbox.create({ iframeUrl: "/iframe.html" });
try {
  const result = await sandbox.run(userCode, { deadlineMs: 2000 });
  showResult(result);
} catch (e) {
  showError("That code could not run: " + e.message);
}
```

Why it works here: the code cannot reach the network, the DOM, or
storage even if it tries — there is nothing to reach. An infinite
loop stops at the deadline instead of hanging the tab, and a memory
bomb is bounded by the heap cap plus the watchdog. The result must be
a string, so a guest cannot smuggle an object (or a proxy, or a
function) back into the host page.

Edge: guest code is a classic script — no top-level `await`. Wrap
async snippets in an async IIFE, or rewrite them host-side before
running.

## 2. AI agent code execution

An agent (LLM or otherwise) produces code that must run before its
output is trusted — data transforms, computed columns, small scripts
against data you supply. This is the highest-risk use case, because
the code author is effectively adversarial: prompt injection can
smuggle instructions into generated code.

```ts
sandbox.registerAsk("getRow", (id) => JSON.stringify(rows[id] ?? null));
const result = await sandbox.run(agentCode, {
  deadlineMs: 5000,
  maxTotalOutputBytes: 64 * 1024,
});
```

Why it works here: the agent's code sees only what you expose through
asks, and only as strings. It cannot exfiltrate the data it was given
(because it has no network), cannot read anything else on the page
(because it has no DOM), and cannot persist anything (because it has
no storage). If the agent's code needs something from outside, it must
go through `host.fetchText`, which you approve per origin — and the
approval prompt shows the true destination, not the agent's claim
about it.

Edge: keep ask handlers narrow and total-output capped. An ask
handler is host code running with host privileges; the allowlist is
yours to keep small. Never register a handler that fetches arbitrary
URLs, reads files, or evaluates code — that would hand the guest the
capability the sandbox exists to withhold.

## 3. Plugin and extension systems

Let third parties (or your own users) extend your app with small
scripts: custom formatters, validators, report builders, dashboard
widgets. Each plugin runs in its own sandbox.

```ts
const plugin = await Sandbox.create({ iframeUrl: "/iframe.html" });
plugin.registerAsk("config", () => JSON.stringify(pluginConfig));
const output = await plugin.run(pluginCode);
plugin.dispose(); // plugins are cheap to tear down and rebuild
```

Why it works here: a malicious or buggy plugin cannot break the host
app — it cannot touch the host DOM, cannot phone home, cannot read
other plugins' data (each sandbox is a separate iframe/worker with
its own port). A plugin that hangs is killed by the watchdog; the
next run rebuilds a fresh session.

Edge: one sandbox per plugin, and dispose sandboxes you no longer
need. A sandbox holds an iframe and a worker; creating hundreds and
never disposing them is host work, not guest work, and is not bounded
by guest limits.

## 4. Guest apps with UI (JSX / React components)

A guest app that renders: a widget, a card, a small tool. The guest
authors components; the host renders them.

```ts
// Guest code (JSX compiled by the app's toolchain into calls):
const tree = {
  type: "div",
  children: [
    { type: "h2", children: ["Sales"] },
    { type: "button", props: { onClick: "refresh" }, children: ["Refresh"] },
  ],
};
host.send(JSON.stringify({ kind: "render", tree }));

// Host side:
sandbox.on("message", (m) => {
  const msg = JSON.parse(m);
  if (msg.kind === "render") {
    renderGuestTree(container, msg.tree, {
      cssText: msg.css,
      onEvent: (id) => sandbox.send(JSON.stringify({ kind: "event", id })),
    });
  }
});
```

Why it works here: the guest never touches the DOM — it describes UI
as data, and the host builds real DOM from it inside a shadow root.
A guest string can never become markup (text nodes, never
`innerHTML`); a guest stylesheet can never fetch (sanitized, and
scoped to the shadow root); a guest event is an opaque id, not a
function. The app keeps a run in flight for the app's lifetime so
`onMessage` keeps working across events (see the demo's counter app).

Edge: rendering is full re-render per tree. For high-frequency
updates (animations, keystroke-level input), batch tree updates
host-side or keep the interactive part in host code and use the guest
for computation, not per-frame rendering.

## 5. CDN-styled widgets

A guest widget that should look like the rest of the web — with a
real stylesheet from a CDN — without giving the guest the network.

```ts
const sandbox = await Sandbox.create({
  iframeUrl: "/iframe.html",
  allowedOrigins: ["https://cdn.jsdelivr.net"],
  onConnectionRequest: (req) => askUser(`Allow ${req.origin}?`),
});
// Guest:
const css = await host.fetchText(
  "https://cdn.jsdelivr.net/npm/normalize.css@8.0.1/normalize.css",
);
host.send(JSON.stringify({ kind: "render", tree, css }));
```

Why it works here: the stylesheet travels through the gate (approved
origin, GET only, size-capped) and through the CSS sanitizer
(`@import` removed, `url()` replaced with `none`) before it is
applied inside the shadow root. The guest never fetches anything
itself, and the stylesheet cannot fetch anything either.

Edge: the target must allow CORS (jsDelivr does). A CDN that does not
send `Access-Control-Allow-Origin` will fail at the browser — that is
the browser enforcing its own rule, not the library, and the guest
sees a plain fetch failure. Also: request the final URL. Redirects
are rejected by the gate, so versioned CDN paths (which do not
redirect) are the right form; unversioned "latest" paths that
redirect to a version will fail.

## 6. Data transforms with host-mediated data access

A guest that transforms data it does not own: CSV cleaning, JSON
reshaping, report computation. Data enters through asks, results
leave as strings.

```ts
sandbox.registerAsk("dataset", () => JSON.stringify(dataset));
sandbox.registerAsk("lookup", (key) => JSON.stringify(index[key] ?? null));
const cleaned = await sandbox.run(transformCode, {
  maxTotalOutputBytes: 256 * 1024,
});
```

Why it works here: the guest's view of the data is exactly what the
asks return — no more. It cannot enumerate the host's data, cannot
reach the network to send a copy elsewhere, and its output is capped
so a "return everything" transform cannot dump an unbounded result.

Edge: asks return strings. Large datasets should be paged through
asks (by id, by page) rather than returned whole — both for the
output cap and for the guest's memory cap.

## 7. User-scriptable rules and automation

"If this, then that" rules, computed fields, validation logic that
users write themselves and that runs on every event or every record.

```ts
// One sandbox per ruleset, reused across evaluations:
const result = await sandbox.run(`(${ruleCode})(${JSON.stringify(record)})`);
```

Why it works here: rules run with a short deadline (tens to hundreds
of milliseconds), a small memory cap, and no side effects available —
a rule cannot do anything but compute and return a string. A bad
rule fails closed (error, not partial effect), and a hanging rule is
killed by the watchdog without taking the app down.

Edge: keep rule deadlines short and cache sandboxes across
evaluations where the ruleset is stable. Creating a sandbox is an
iframe + worker + handshake; it is not free, so do not create one per
record.

## 8. Educational coding environments

Teach JavaScript in the browser: students write code, see output,
cannot break anything. The guest's errors are reported as strings,
and the host page (grades, progress, other students' work) is
unreachable from guest code.

Why it works here: every threat a curious student might try — fetch
to an outside server, read `localStorage`, touch the page DOM,
infinite loop, fork-bomb-style allocation — is either absent from
the guest environment or bounded by a limit with a clean error. The
teacher's UI and the student's code share a page but not a realm.

Edge: student code that needs to "show" something should use the
rendering path (element trees) rather than expecting DOM access.
Document that difference early — it is the one conceptual step
students trip on.

## 9. Multi-tenant formatting and templating

Render user-supplied templates (invoices, emails, reports) where the
template language is JavaScript. Tenants must not see each other's
data or reach the host.

Why it works here: each tenant's template runs in its own sandbox
with only that tenant's data exposed through asks. Template code
cannot reach across tenants because there is no shared realm, no
shared storage, and no network. Output is a string, so a template
cannot return a live object into the host.

Edge: templates that need images or fonts from outside must go
through the gate (text) or be embedded as `data:` URLs (images in
rendered trees). Remote image URLs in guest trees are dropped by
design — that is the exfiltration guard, not a bug.

## 10. Safe evaluation of configuration-as-code

Configuration that is really code: feature flags with logic, pricing
rules, access policies, routing tables. Teams want the expressiveness
of code with the safety of data.

```ts
const decision = await sandbox.run(
  `(${policyCode})(${JSON.stringify(context)})`,
  { deadlineMs: 200, memoryLimitBytes: 1024 * 1024 },
);
```

Why it works here: policy code runs with tiny limits, no
capabilities, and a string result. A policy cannot phone home with
the context it was given, cannot read other policies, and cannot
persist a backdoor — it is re-evaluated fresh from source every time.

Edge: policies are code, so they need the same review discipline as
any code that runs with host privileges — except here the blast
radius of a bad policy is one string result and one error, not host
compromise. Review for correctness, not for escape, because escape
is what the sandbox removes.

## What icecream-sandbox is not

- **Not a DOM sandbox for arbitrary web pages.** A guest HTML page
  with real DOM APIs is a different product with a different threat
  model. Here the guest describes UI as data; the host builds DOM.
- **Not a Node sandbox.** There is no filesystem, no process, no
  module system in the guest. `require`, `import`, and `process` do
  not exist.
- **Not a privacy sandbox against side channels.** Timing and
  memory-usage channels are out of scope (see the threat model).
- **Not a substitute for reviewing host functions.** Ask handlers
  and approval callbacks run with host privileges. Keep them narrow:
  an ask handler that fetches arbitrary URLs hands the guest the
  network with your authority.
