// Demo server for icecream-sandbox.
//
// Serves:
//   /             -> demo/demo.html (the host page, no sandbox headers)
//   /iframe.html  -> dist/iframe.html with the exact restrictive headers
//                    from the spec: CSP + Permissions-Policy
//   /dist/*       -> the built host library (ES modules)
//
// The iframe document's frame-ancestors is set dynamically from the
// request's Host header, so the demo works on localhost, on a LAN IP,
// or behind any host name without editing headers. The demo server is
// plain HTTP, so the ancestor is http://<host>.
//
// Usage: node demo/demo-server.mjs [port]   (default port 8901)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || 8901);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".d.ts": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function permissionsPolicy() {
  // Deny everything the iframe could never legitimately need.
  const features = [
    "camera", "microphone", "geolocation", "payment", "usb",
    "magnetometer", "gyroscope", "accelerometer", "ambient-light-sensor",
    "autoplay", "encrypted-media", "fullscreen", "picture-in-picture",
    "sync-xhr", "xr-spatial-tracking", "clipboard-read", "clipboard-write",
    "display-capture", "hid", "serial", "bluetooth", "otp-credentials",
    "window-management", "local-fonts",
  ];
  return features.map((f) => `${f}=()`).join(", ");
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  try {
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(readFileSync(join(root, "demo", "demo.html")));
      return;
    }
    if (path === "/iframe.html" || path === "/canary-probe.html") {
      // The canary probe is served with the IDENTICAL headers as the real
      // iframe document, so its blocked-network result proves the header's
      // effect on a sandboxed-iframe context.
      const host = req.headers.host || `localhost:${port}`;
      const csp = [
        "default-src 'none'",
        "script-src 'wasm-unsafe-eval' 'unsafe-inline'",
        "worker-src blob:",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors http://${host}`,
      ].join("; ");
      const file = path === "/iframe.html"
        ? join(root, "dist", "iframe.html")
        : join(root, "test", "browser", "canary-probe.html");
      res.writeHead(200, {
        "content-type": MIME[".html"],
        "content-security-policy": csp,
        "permissions-policy": permissionsPolicy(),
      });
      res.end(readFileSync(file));
      return;
    }
    if (path === "/harness.html") {
      // Test-only harness page (no sandbox headers — it is the host page).
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(readFileSync(join(root, "test", "browser", "harness.html")));
      return;
    }
    if (path === "/theme.css") {
      // Sample stylesheet for the gated-fetch demo. It deliberately
      // contains an @import and a url() trap so the demo shows them being
      // stripped before the CSS reaches the rendered app.
      res.writeHead(200, { "content-type": "text/css" });
      res.end(
        "p { color: rgb(1, 2, 3); }\n" +
          "@import url(\"https://evil.example/a.css\");\n" +
          "div { background-image: url(\"https://evil.example/p.png\"); }\n",
      );
      return;
    }
    if (path.startsWith("/examples/")) {
      // Example pages (e.g. /examples/population-chart.html).
      const file = normalize(join(root, path));
      if (!file.startsWith(join(root, "examples") + "/")) {
        res.writeHead(403); res.end("forbidden"); return;
      }
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(readFileSync(file));
      return;
    }
    if (path.startsWith("/dist/")) {
      const file = normalize(join(root, path));
      if (!file.startsWith(join(root, "dist") + "/")) {
        res.writeHead(403); res.end("forbidden"); return;
      }
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});

server.listen(port, () => {
  console.log(`icecream-sandbox demo at http://localhost:${port}/`);
});
