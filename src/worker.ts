/**
 * Worker entry point. Thin adapter only: it owns the MessagePort the iframe
 * transferred in, buffers port messages until the QuickJS module is loaded,
 * and forwards everything to GuestRunner.
 *
 * The worker script is bundled (with the singlefile QuickJS build) into one
 * file and loaded from a Blob URL, so it performs no network fetch at all.
 */
import { GuestRunner } from "./guest-runner.js";
import { encodeMessage } from "./protocol.js";

// The worker global, without pulling in the WebWorker lib (which conflicts
// with the DOM lib this project uses for the host side).
const workerGlobal = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
};

let runner: GuestRunner | null = null;
let port: MessagePort | null = null;
let nonce = "";
const queued: string[] = [];
let ready = false;

function sendToHost(raw: string): void {
  if (port !== null) port.postMessage(raw);
}

function drain(): void {
  if (runner === null || !ready) return;
  while (queued.length > 0) {
    const raw = queued.shift();
    if (raw !== undefined) runner.handleMessage(raw);
  }
}

workerGlobal.onmessage = (event: MessageEvent): void => {
  const data = event.data as { type?: unknown; nonce?: unknown } | null;
  if (data === null || typeof data !== "object" || data.type !== "init") return;
  const transferred = event.ports[0];
  if (transferred === undefined) return;
  port = transferred;
  nonce = typeof data.nonce === "string" ? data.nonce : "";
  port.onmessage = (portEvent: MessageEvent): void => {
    if (typeof portEvent.data !== "string") return;
    if (runner === null) {
      queued.push(portEvent.data);
    } else {
      runner.handleMessage(portEvent.data);
    }
  };
  void GuestRunner.create(sendToHost)
    .then((created) => {
      runner = created;
      ready = true;
      sendToHost(encodeMessage({ t: "ready", nonce }));
      drain();
    })
    .catch(() => {
      // If QuickJS cannot load, there is nothing to run. The host's
      // handshake timeout surfaces this as a creation failure.
    });
};
