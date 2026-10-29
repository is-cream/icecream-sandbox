// Canary server: records EVERY request it receives so tests can prove
// zero requests arrived. Endpoints:
//   GET /__log   -> JSON array of recorded requests
//   GET /__reset -> clears the log
//   anything else -> recorded, answered 200 "canary"
import { createServer } from "node:http";

const port = Number(process.argv[2] || 8902);
const log = [];

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
