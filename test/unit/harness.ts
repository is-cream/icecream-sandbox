/**
 * In-process harness: a Session wired to a GuestRunner over fake ports.
 * Delivery is async (queueMicrotask), like a real MessagePort, but everything
 * runs in Node so the core logic is testable without a browser.
 */
import { GuestRunner } from "../../src/guest-runner.js";
import { Session, type PortLike } from "../../src/session.js";

export interface Pair {
  session: Session;
  runner: GuestRunner;
  close: () => void;
}

export async function createPair(): Promise<Pair> {
  let runnerRef: GuestRunner | null = null;
  const sessionPort: PortLike = {
    onmessage: null,
    postMessage: (message: string) => {
      queueMicrotask(() => {
        runnerRef?.handleMessage(message);
      });
    },
  };
  const session = new Session(sessionPort, {
    maxInboundBytes: 8 * 1024 * 1024,
    expectedNonce: "test-nonce",
  });
  const runner = await GuestRunner.create((raw: string) => {
    queueMicrotask(() => {
      // PortLike.onmessage carries MessagePort's this-type; the harness
      // calls it as a plain function, so narrow the type at the call site
      // instead of loosening the library's PortLike.
      const handler = sessionPort.onmessage as unknown as
        | ((event: { data: string }) => void)
        | null;
      handler?.({ data: raw });
    });
  });
  runnerRef = runner;
  return {
    session,
    runner,
    close: () => {
      session.dispose();
      runner.dispose();
    },
  };
}
