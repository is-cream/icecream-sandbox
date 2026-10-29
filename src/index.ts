/**
 * icecream-sandbox — public host-side API.
 *
 * Serve dist/iframe.html from your own origin with the CSP and
 * Permissions-Policy in the README, then:
 *
 *   import { Sandbox } from "icecream-sandbox";
 *   const sandbox = await Sandbox.create({ iframeUrl: "/sandbox/iframe.html" });
 *   const result = await sandbox.run(`host.send("hello"); "done"`);
 *   sandbox.dispose();
 */
export { Sandbox, type SandboxOptions } from "./host.js";
export { DEFAULT_LIMITS, MAX_STACK_SIZE, resolveLimits, type ResolvedLimits, type RunLimits } from "./limits.js";
export type { AskHandler, SessionEvent } from "./session.js";
export {
  ConnectionGate,
  normalizeOrigin,
  type ConnectionApprovalHandler,
  type ConnectionApprovalRequest,
  type ConnectionDecision,
  type ConnectionGateOptions,
} from "./connections.js";
export {
  renderGuestTree,
  sanitizeCss,
  sanitizeStyleValue,
  validateTree,
  type GuestNode,
  type RenderOptions,
} from "./render.js";
