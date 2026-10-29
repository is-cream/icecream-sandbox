# icecream-sandbox: threat model

A formal statement of what is protected, from whom, where the trust
boundaries are, and what is explicitly out of scope. The companion
document, [threats-and-tests.md](threats-and-tests.md), maps each
threat below to the mechanism that stops it and the test that proves
it. The [design doc](design.md) shows the flows and boundaries with
diagrams.

## 1. What is being protected (assets)

| Asset | Why it matters |
| --- | --- |
| Host page DOM and JavaScript state | The app's UI, variables, and logic. A guest that could touch these could rewrite the app. |
| Host origin storage and cookies | `localStorage`, `indexedDB`, cookies, caches. A guest that could read these could steal sessions. |
| Host credentials | The host page's login, tokens, and ambient authority. A guest that could ride these could act as the user. |
| Data passed to the guest | Rows, configs, and context the app deliberately shares through asks. The guest must not get more than shared, or send a copy elsewhere. |
| Other guests' data | Each sandbox's data must stay in its own sandbox. No cross-guest reads. |
| The user's network position | The browser's ability to make requests. A guest must not turn the user's browser into a request source for its own ends. |
| Host availability | The tab must keep working. A guest must not hang or exhaust the page. |
| The user's attention (approval integrity) | Approval prompts must mean what they say. A guest that could fake a "yes" owns the gate. |

## 2. Who the attacker is (threat actors)

- **A1 — Malicious guest author.** Writes arbitrary guest code with
  the goal of escaping, exfiltrating, or disrupting. This is the
  primary actor. Assume the code is crafted by someone who has read
  this library's source.
- **A2 — Buggy or curious guest.** Not malicious, but tries things
  (loops, huge allocations, weird inputs) that must fail safely
  rather than break the host.
- **A3 — Compromised outside resource.** A CDN stylesheet, an API
  response, or a dependency that turns hostile after approval. The
  gate approves an origin, not the content's future behavior.
- **A4 — Malicious host page (out of scope).** If the host page
  itself is hostile, there is nothing to protect: the host owns the
  sandbox, the gate, and the renderer. The model assumes the host
  page is trusted. See §6.
- **A5 — Network attacker (partial).** Can observe or tamper with
  plaintext (`http`) traffic. The gate allows `http` URLs when
  approved, so content integrity over `http` is NOT guaranteed. Apps
  that need integrity should pre-approve `https` origins only. The
  browser's TLS and CORS enforcement are relied on, not reimplemented.

## 3. Trust boundaries

```
Guest code ──[realm]──► host global ──[port]──► host page ──[gate]──► outside world
                │                        │                     │
           no network,              JSON strings only,     approved GET only,
           no DOM, no storage       shape-checked,          credentials omitted,
                                     nonce handshake         redirects rejected
```

- **Boundary 1 — QuickJS realm.** The guest realm contains no
  network, DOM, storage, timer, or Node globals. Nothing puts them
  there. The only global added is `host`, whose three functions send
  JSON messages.
- **Boundary 2 — Worker + CSP.** The worker runs from a Blob URL
  inside an iframe served with `connect-src 'none'`. Even a guest
  that somehow obtained a real `fetch` would have its request
  blocked here.
- **Boundary 3 — Sandboxed iframe.** `sandbox="allow-scripts"`
  only, opaque origin. The iframe document cannot reach host-origin
  storage or cookies, and it holds no state of its own.
- **Boundary 4 — Host-side gate and renderer.** The only sanctioned
  paths out of the sandbox. Both are host code, both fail closed,
  and neither trusts guest input: the gate validates URLs and
  approvals; the renderer validates trees and sanitizes CSS.

Each boundary blocks whole classes independently. Defense in depth
here is not a slogan: a single boundary failing (a QuickJS bug, a
CSP bypass, a browser sandbox flaw) still leaves the others standing.

## 4. STRIDE analysis

### 4.1 Guest realm (guest code vs. host)

| Threat | Analysis | Mitigation |
| --- | --- | --- |
| **Spoofing** — guest pretends to be the host | The guest cannot send messages except as itself over its own port. It cannot forge host messages because it holds no host port and no host identity. | Port ownership: only the host holds the host end; the guest end is transferred once via the nonce handshake. |
| **Tampering** — guest corrupts host state | The guest has no shared objects with the host. Messages are JSON strings, parsed fresh on receipt. Prototype pollution in the guest realm stays in the guest realm (separate QuickJS `Object.prototype`). | JSON-only wire; fresh runtime per run; no shared realm. |
| **Repudiation** — guest denies an action | Not applicable in the usual sense: guest actions are either host-observed messages (logged by the app if it chooses) or nothing. The library does not provide audit logging; apps that need it log `on("message")` themselves. | App-layer logging (documented, not built in). |
| **Information disclosure** — guest reads host data | The guest sees only what asks return and what gate fetches return (body text only, never headers or cookies). It cannot enumerate host state. | Ask allowlist; gate body-only returns; no DOM/storage globals. |
| **Denial of service** — guest hangs or exhausts the host | Loops, memory bombs, message floods, and deep trees are all bounded. | Deadline interrupt, memory/stack caps, message/output caps, tree caps, watchdog (1.5× deadline) + session rebuild. |
| **Elevation of privilege** — guest escapes to host | Escape requires crossing all four boundaries. The known escape routes (DOM access, storage access, network access, host objects) are absent by construction, not by check. | Layered boundaries; fresh runtime per run; no host objects cross the wire. |

### 4.2 Port and protocol (message forgery and flooding)

| Threat | Analysis | Mitigation |
| --- | --- | --- |
| Forged messages from another window | The iframe accepts the first handshake's `event.source` and verifies the nonce. Later sources are ignored. The port itself is transferred, not addressable by name. | Nonce + first-source-wins handshake (`iframe-bootstrap.js`). |
| Malformed messages crashing the host | Every inbound message is shape-checked (`decodeMessage`); malformed input returns null and is ignored. No handler throws on peer input. | Fail-closed decode; callers ignore null. |
| Oversized messages exhausting memory | Decode enforces `maxInboundBytes` before parsing completes; per-message and total-output caps bound the rest. | `maxInboundBytes`, `maxMessageSize`, `maxTotalOutputBytes`. |
| Replayed or stale messages | Message ids are per-run and per-session; a reply for a finished run's id is ignored (no pending entry). A failed session is never reused, so stale ports die with it. | Id matching against live pending maps; session failure closes the port. |

### 4.3 Iframe (escape and UI attacks)

| Threat | Analysis | Mitigation |
| --- | --- | --- |
| Iframe escape via `allow-same-origin` | Adding it would let the iframe document reach host-origin storage and cookies. It is never added, and there is no option to add it. | Hardcoded `sandbox="allow-scripts"`; documented invariant. |
| Iframe navigation / top-level hijack | The iframe runs no guest DOM and no guest navigation code; the bootstrap only creates a worker and forwards watchdog orders. | Bootstrap holds no navigation capability. |
| Clickjacking / UI redress | The iframe is 1×1 px, `aria-hidden`, and non-interactive. It presents no UI to spoof or clickjack. | Non-interactive sizing; no guest UI lives in the iframe (guest UI lives in the host's shadow DOM). |
| Wrong-source worker messages | The worker port is transferred exactly once through the verified handshake; the session ignores messages with the wrong nonce. | Nonce verification on `ready`; port transfer (not broadcast). |

### 4.4 Connection gate (confused deputy and bypass)

| Threat | Analysis | Mitigation |
| --- | --- | --- |
| Guest tricks the host into fetching for it | The guest cannot fetch; it can only request. Every request is checked against the allowlist, grants, or an explicit user approval. | Gate decision before any fetch; deny by default. |
| Approval spoofing | If the approval prompt were rendered where the guest can influence it, the guest could fake a "yes". | The callback runs in host-page UI by construction; the library never renders the prompt. App responsibility to keep it there. |
| Redirect bypass | An approved origin redirecting to an unapproved one would move the request outside the approval. Browsers hide redirect destinations (opaque-redirect), so the gate cannot re-check hops. | Redirects rejected outright, never followed. |
| Credential riding | A host-side fetch with ambient credentials would let the guest trigger authenticated requests. | `credentials: "omit"` on every gate fetch. |
| Header/cookie leakage to the guest | Response headers can carry tokens (e.g. `set-cookie`, auth). Returning them would hand the guest host-side secrets. | Only the body text is returned; headers are never exposed. |
| Oversized responses exhausting the host | A hostile origin could return gigabytes. | Streaming read with `maxResponseBytes` cap; port `maxInboundBytes` backstop. |
| Slow responses hanging the guest run | A hostile origin could stall forever. | `connectionTimeoutMs`; run deadline; session watchdog. |
| DNS rebinding / origin-name trust | Approval is by origin name, not IP. If an approved hostname's DNS is attacker-controlled, the fetch could reach an unexpected address. Browsers' Private Network Access rules are a backstop for public-to-private fetches, but this is a residual risk for sensitive deployments. | Documented residual risk: approve only origins you trust to keep their DNS; prefer specific versioned CDN paths. |
| Prompt fatigue → blanket approval | Session grants trade re-prompting for broader access. A user who grants an origin for the session grants every path on that origin until `dispose()` or revocation. | Grants are per-origin (not per-URL) by design, in memory only, revocable, and visible via `getConnectionGrants()`. Apps should show grants in their UI. |
| CORS bypass | The gate does not bypass CORS: cross-origin fetches still need the target's CORS headers. A target that does not send them fails at the browser. This is a limitation, not a bypass — the gate cannot make the browser violate its own policy. | Browser enforcement (relied on, not reimplemented). |

### 4.5 Renderer (markup, style, and event injection)

| Threat | Analysis | Mitigation |
| --- | --- | --- |
| Markup injection (XSS) | A guest string rendered as HTML would execute in the host page. | No `innerHTML` anywhere; text children become text nodes. |
| Dangerous elements | `script`, `iframe`, `object`, `embed`, `form`, `style`, `link`, `meta`, `base` from the guest would each be a capability (execution, embedding, submission, style injection). | Tag allowlist; everything else rejected before DOM. |
| Style exfiltration | CSS `url()` and `@import` cause fetches from the host page — a guest stylesheet could exfiltrate data in URLs or load hostile sheets. | `sanitizeCss` (comments stripped, `@import` removed, `url()` → `none`) for stylesheets; `sanitizeStyleValue` for inline style objects. Shadow-root scoping. |
| Image exfiltration | A remote `<img src>` makes the host page fetch a guest-chosen URL — data in the URL query would leak. | Remote `src` dropped; `data:` URLs only. |
| Link attacks | `javascript:` hrefs execute on click; `_blank` links without `rel` give the new page `window.opener` access. | `href` restricted to `http(s)`; `_blank` gets `rel="noopener"`. |
| Event handler injection | A guest function as an event handler would run guest code in host context. | Event props must be string ids; the host maps ids to listeners. |
| Prototype pollution via trees | A tree prop object could pollute `Object.prototype` if merged carelessly. | Props must be string/number/boolean (objects rejected); trees are never merged into host objects — they are read field by field. |
| Tree bombs | A deeply nested or enormous tree could exhaust the host page building DOM. | Depth 32 and 5000-node caps enforced before any DOM is built. |
| Host-style leakage | Guest CSS escaping the shadow root could restyle the host page (defacement, UI spoofing). | Shadow DOM scoping; guest styles live inside the shadow root only. |

### 4.6 Session lifecycle (reuse and persistence)

| Threat | Analysis | Mitigation |
| --- | --- | --- |
| Reuse after corruption | A runtime that survived an out-of-memory error may have a corrupt heap; reusing it risks undefined behavior. | Fresh runtime per run; never reused after any error. |
| Reuse after failure | A failed session's port may deliver stale messages. | Failed sessions are marked, ports closed, never reused; rebuild is lazy on next `run()`. |
| Grant persistence across rebuilds | Grants surviving a watchdog rebuild could surprise a user who expected a fresh start. | Intended behavior, documented: grants live on the `Sandbox` (user-approved, session-scoped) and die on `dispose()` or revocation — not on worker death. |
| Grant theft by the guest | The guest could read grants and learn which origins the user trusts (information disclosure) or modify them. | Grants and allowlist are host-side only; no guest API exposes them (tested). |

## 5. Assumptions (if these break, the model breaks)

1. **The host page is trusted.** A hostile host page owns everything
   anyway; the library protects the host from the guest, not from
   itself.
2. **The browser's sandbox, CSP, and fetch implementations are
   correct.** A browser bug that breaks iframe sandboxing or CSP
   enforcement breaks boundary 2 and 3. The library keeps boundaries
   1 and 4 as backstops.
3. **QuickJS and its WASM embedding are correct.** An engine bug
   that lets guest code escape its realm breaks boundary 1. The
   library keeps boundaries 2–4 as backstops and pins dependency
   versions so engine changes are deliberate.
4. **The app serves `dist/iframe.html` with the documented headers**
   and never adds `allow-same-origin`. Headers are the app's
   responsibility; the README shows the exact set.
5. **The user reads approval prompts.** A user who approves every
   prompt without reading has delegated their judgment to the guest.
   Session grants make this worse if misused (see §4.4) and better
   if used for origins the user genuinely trusts.
6. **Ask handlers and approval callbacks are written carefully.**
   They run with host privileges. A handler that fetches arbitrary
   URLs or evaluates code hands the guest that capability with the
   host's authority. Keep them narrow.

## 6. Out of scope (explicitly not defended)

- **Side channels.** Timing, memory-usage, and other side channels
  between guest code and the host are out of scope.
- **Engine and browser bugs.** Vulnerabilities in QuickJS, the WASM
  runtime, or the browser's sandbox implementation are outside what
  this library can fix. Keep dependencies pinned and updated.
- **Main-thread denial of service.** The guest runs off the main
  thread, but a flood of runs, oversized code, or rapid sandbox
  creation is still host work. Rate-limit `run()` and sandbox
  creation at your layer if guests are untrusted at that level.
- **Host-app misuse.** Ask handlers, approval callbacks, and
  allowlists are the app's responsibility. The library makes misuse
  hard (deny by default, narrow APIs) but cannot make it impossible.
- **Audit logging.** The library does not log guest actions. Apps
  that need an audit trail log `on("message")` and approval decisions
  themselves.
- **Content integrity over `http`.** Plaintext fetches can be
  observed and tampered with on the network. Apps needing integrity
  approve `https` origins only.
- **Availability of outside origins.** The gate cannot make a CDN or
  API reachable, fast, or honest. Timeouts and size caps bound the
  damage from a slow or huge response; they do not fix a lying one.

## 7. Residual risks (accepted, with notes)

| Risk | Severity | Note |
| --- | --- | --- |
| DNS rebinding of an approved origin | Low–Medium | Approval is by name. Mitigated by browser Private Network Access rules and by approving only trusted origins. |
| Prompt fatigue → over-granting | Low–Medium | Session grants reduce prompts by design. Apps should surface current grants and offer revocation. |
| CSS parser gaps in `sanitizeCss` | Low | String filtering, not a full CSS parser. Exotic future CSS syntax that fetches is outside what filtering can guarantee. A real CSS parser is the follow-up if richer stylesheets are needed. |
| QuickJS/WASM engine bug | Low | Backstopped by the iframe, worker CSP, and gate; pinned versions make upgrades deliberate. |
| `http` content tampering | Low (for apps that approve `https` only) | Documented: approve `https` origins when integrity matters. |
| Host-page compromise | Out of scope | If the host page is hostile, the model does not apply (§2, A4). |

## 8. How to use this document

- **Before integrating:** read §5 and §6. If any assumption fails
  for your app, the library alone does not cover you.
- **When adding a feature:** re-run this analysis for the new
  surface. Every new guest capability needs a STRIDE row and a test
  in the security suite (`npm run test:security`).
- **When reviewing a change:** check it against the invariants in
  the design doc. A change that weakens a boundary needs a new
  mitigation, not a new exception.
