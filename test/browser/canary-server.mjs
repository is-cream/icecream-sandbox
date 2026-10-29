// Canary server: records EVERY request it receives so tests can prove
// zero requests arrived. Endpoints:
//   GET /__log   -> JSON array of recorded requests
//   GET /__reset -> clears the log
//   anything else -> recorded, answered 200 "canary"
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] || 8902);
const log = [];
// The real published d3-format build, vendored in examples/vendor.
// Served here so import tests download genuine third-party code from a
// distinct origin (localhost:8902) through the gate.
const d3Format = readFileSync(
  new URL("../../examples/vendor/d3-format.mjs", import.meta.url),
  "utf8",
);

const server = createServer((req, res) => {
  // Test-only local server: allow the harness page (another localhost
  // port) to read the log. The probe's own requests must never arrive
  // at all — CSP blocks them before CORS is ever evaluated.
  const cors = { "access-control-allow-origin": "*" };
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/__log") {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify(log));
    return;
  }
  if (url.pathname === "/__reset") {
    log.length = 0;
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify({ reset: true }));
    return;
  }
  if (url.pathname === "/__redirect") {
    // Redirect to a DIFFERENT origin (127.0.0.1 vs localhost) so tests can
    // prove the gate re-checks redirect hops instead of trusting the first
    // approval. This redirect itself is not logged as a body fetch.
    res.writeHead(302, { location: "http://127.0.0.1:8902/ping", ...cors });
    res.end();
    return;
  }
  if (url.pathname === "/__big") {
    res.writeHead(200, { "content-type": "text/plain", ...cors });
    res.end("x".repeat(1536 * 1024));
    return;
  }
  if (url.pathname === "/d3-format.mjs") {
    // Logged like any other fetch: import tests count these requests to
    // prove caching (second import = zero new requests).
    log.push({ method: req.method, url: req.url, time: Date.now() });
    res.writeHead(200, { "content-type": "text/javascript", ...cors });
    res.end(d3Format);
    return;
  }
  if (url.pathname === "/mod-wrapper.mjs") {
    // Test fixture (our own code): re-exports format from a relative
    // sibling, proving transitive import resolution.
    log.push({ method: req.method, url: req.url, time: Date.now() });
    res.writeHead(200, { "content-type": "text/javascript", ...cors });
    res.end(`export { format } from './d3-format.mjs';\n`);
    return;
  }
  if (url.pathname === "/x-wrapper.mjs") {
    // Test fixture (our own code): re-exports format from a DIFFERENT
    // origin (127.0.0.1 vs localhost), proving every transitive hop is
    // gated on its own origin — the first origin's grant does not cover
    // the second hop.
    log.push({ method: req.method, url: req.url, time: Date.now() });
    res.writeHead(200, { "content-type": "text/javascript", ...cors });
    res.end(`export { format } from 'http://127.0.0.1:${port}/d3-format.mjs';\n`);
    return;
  }
  if (url.pathname === "/theme.css") {
    res.writeHead(200, { "content-type": "text/css", ...cors });
    res.end(
      "p { color: rgb(1, 2, 3); }\n" +
        "@import url(\"https://evil.example/a.css\");\n" +
        "div { background-image: url(\"https://evil.example/p.png\"); }\n",
    );
    return;
  }
  log.push({ method: req.method, url: req.url, time: Date.now() });
  res.writeHead(200, { "content-type": "text/plain", ...cors });
  res.end("canary");
});

server.listen(port, () => {
  console.log(`canary server at http://localhost:${port}/`);
});
