// Iframe bootstrap. This file is inlined into dist/iframe.html by the build
// script, which substitutes the worker bundle for the single placeholder
// expression in createWorker below. The placeholder token appears exactly
// once in this file, in code — never in a comment — so the build's string
// replacement cannot land in the wrong place (a stale build once embedded
// the bundle into a comment instead, leaving the worker source broken).
//
// The iframe runs with sandbox="allow-scripts" and an opaque origin, so it
// has no cookies, no storage, no DOM access to the host page, and no way
// to fetch anything. The worker below is created from a Blob URL, so no
// network request is needed at runtime either.
//
// Trust model: the FIRST handshake message's event.source is trusted as
// the parent (the iframe cannot check origin — its own origin is "null").
// Every later message must come from that same source and carry the
// current nonce. A watchdog message from the host terminates the worker;
// the host-side session is then rebuilt on the next run, which arrives as
// a fresh handshake with a new nonce and a new port.
(function () {
  "use strict";

  var worker = null;
  var trustedParent = null;
  var nonce = null;

  function createWorker(port, nextNonce) {
    if (worker) {
      try {
        worker.terminate();
      } catch (e) {
        // Already dead; the new worker still starts.
      }
      worker = null;
    }
    var source = __WORKER_SOURCE__;
    var blob = new Blob([source], { type: "text/javascript" });
    var url = URL.createObjectURL(blob);
    worker = new Worker(url);
    worker.postMessage({ type: "init", nonce: nextNonce }, [port]);
  }

  self.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (trustedParent === null) {
      if (data.type !== "sandbox-handshake" || typeof data.nonce !== "string") return;
      var firstPort = event.ports && event.ports[0];
      if (!firstPort) return;
      trustedParent = event.source;
      nonce = data.nonce;
      createWorker(firstPort, nonce);
      return;
    }
    if (event.source !== trustedParent) return;
    if (data.type === "sandbox-watchdog" && data.nonce === nonce) {
      if (worker) {
        try {
          worker.terminate();
        } catch (e) {
          // Already dead.
        }
        worker = null;
      }
      return;
    }
    if (data.type === "sandbox-handshake" && typeof data.nonce === "string") {
      var nextPort = event.ports && event.ports[0];
      if (!nextPort) return;
      nonce = data.nonce;
      createWorker(nextPort, nonce);
    }
  });
})();
