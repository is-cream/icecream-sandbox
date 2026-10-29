// Build: typecheck + emit the host library, bundle the worker (with the
// embedded singlefile QuickJS build) into one file, and generate the
// self-contained iframe document that creates the worker from a Blob URL.
//
// Outputs in dist/:
//   host.js / host.d.ts, session.js, limits.js, protocol.js, index.js
//     — the published host-side library (imported by integrators).
//   worker.bundle.js — the worker script, QuickJS included, no fetches.
//   iframe.html — the document integrators serve with the restrictive CSP.
//     It inlines the worker bundle as one string literal and creates the
//     worker from a Blob URL, so the iframe performs no network request.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

// 1. Typecheck and emit the library (host side + types).
run("npx", ["tsc", "-p", "tsconfig.build.json"]);

// 2. Bundle the worker. The singlefile QuickJS variant embeds its WASM as
// base64, so the bundle is fully self-contained: no .wasm fetch at runtime.
//
// "fs" is external on purpose: the emscripten module requires it only in
// its Node branch (guarded by a runtime is-Node check), which never runs
// in a worker. Bundling it would fail; leaving the require in place is
// safe because that branch is unreachable in a browser worker.
await esbuild.build({
  entryPoints: [join(root, "src", "worker.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: join(dist, "worker.bundle.js"),
  external: ["fs"],
  logLevel: "info",
});

// 3. Generate the iframe document.
const bundle = readFileSync(join(dist, "worker.bundle.js"), "utf8");
const bootstrap = readFileSync(join(root, "src", "iframe-bootstrap.js"), "utf8");
// JSON-encode the bundle, then escape "</" so a "</script" sequence inside
// the bundle can never terminate the embedding <script> element. In a JS
// string literal, "\/" evaluates to "/", so the worker receives the bundle
// byte-identical.
const embedded = JSON.stringify(bundle).replace(/<\//g, "<\\/");
if ((bootstrap.match(/__WORKER_SOURCE__/g) || []).length !== 1) {
  throw new Error(
    "iframe-bootstrap.js must contain the worker-source placeholder exactly once",
  );
}
// Replacer function on purpose: a string replacement would interpret $&,
// $', and friends inside the bundle as match substitutions and corrupt it.
const iframeScript = bootstrap.replace("__WORKER_SOURCE__", () => embedded);
if (iframeScript.includes("__WORKER_SOURCE__")) {
  throw new Error("worker-source placeholder survived the iframe build");
}
const iframeHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>icecream-sandbox iframe</title>
<!--
  Served with: sandbox="allow-scripts" on the <iframe> element, plus the
  CSP and Permissions-Policy in the README. This document must stay
  self-contained: it performs no fetch, and the worker below is created
  from a Blob URL so no network request is needed at runtime.
-->
</head>
<body>
<script>${iframeScript}</script>
</body>
</html>
`;
writeFileSync(join(dist, "iframe.html"), iframeHtml);
console.log(`iframe.html: worker bundle ${bundle.length} chars embedded`);
