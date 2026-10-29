/**
 * Host-side connection gate: the ONLY way guest code can ever reach the
 * network, and only through the host, only with permission.
 *
 * The guest has no fetch, no socket, and no way to touch this gate — it can
 * only ask, via host.fetchText(url), and the gate decides. The gate holds
 * two lists, both host-side, both invisible and unmodifiable from the
 * guest:
 *
 * - allowedOrigins: origins the embedding app pre-approves (its config).
 * - sessionGrants: origins the USER approved during this sandbox's life,
 *   granted per origin, kept in memory only, cleared on dispose().
 *
 * A request whose origin is on neither list goes to the approval callback
 * (the app's human-in-the-loop UI, which must run in the host page, never
 * inside the sandbox where the guest could fake it). The callback answers
 * per request: "allow-once", "allow-session" (grant this origin until
 * dispose), or "deny". No callback means deny — the gate fails closed.
 *
 * When a request is approved, the HOST performs it: GET only, credentials
 * omitted (the guest can never ride the host's login), redirects REJECTED
 * outright (never followed), response body size-capped and returned as
 * text. Headers, cookies, and credentials are never returned to the guest.
 *
 * Why redirects are rejected instead of followed: in browsers, a fetch
 * with redirect handling set to manual returns an opaque-redirect
 * response (status 0, no headers) — the destination is invisible, so a
 * gate cannot re-check it. Following redirects blindly would let an
 * approved origin bounce the request to an unapproved one. Requesting the
 * final URL directly (https, versioned CDN path) is the safe form, and it
 * behaves identically in Node and in browsers.
 */

export type ConnectionDecision = "allow-once" | "allow-session" | "deny";

export interface ConnectionApprovalRequest {
  /** The full URL the guest asked for. */
  url: string;
  /** The normalized origin (scheme + host + port) being asked about. */
  origin: string;
}

export type ConnectionApprovalHandler = (
  request: ConnectionApprovalRequest,
) => ConnectionDecision | Promise<ConnectionDecision>;

export interface ConnectionGateOptions {
  /** Origins the app pre-approves, e.g. ["https://cdn.jsdelivr.net"]. */
  allowedOrigins?: string[] | undefined;
  /** Human-in-the-loop callback. Absent means deny unless pre-allowed/granted. */
  onRequest?: ConnectionApprovalHandler | undefined;
  /** Max response body bytes returned to the guest. Default 1 MiB. */
  maxResponseBytes?: number | undefined;
  /** Per-request timeout in milliseconds. Default 10000. */
  timeoutMs?: number | undefined;
  /** Fetch implementation override (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_URL_LENGTH = 8192;

/** Normalize an origin string, or null when it is not a bare http(s) origin. */
export function normalizeOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // A bare origin serializes to itself: any path, query, or hash disqualifies.
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  return parsed.origin;
}

export class ConnectionGate {
  private readonly allowedOrigins = new Set<string>();
  private readonly grants = new Set<string>();
  private readonly onRequest: ConnectionApprovalHandler | undefined;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ConnectionGateOptions = {}) {
    for (const origin of options.allowedOrigins ?? []) {
      const normalized = normalizeOrigin(origin);
      if (normalized === null) {
        throw new Error(`allowedOrigins: not a bare http(s) origin: ${origin}`);
      }
      this.allowedOrigins.add(normalized);
    }
    this.onRequest = options.onRequest;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new Error("maxResponseBytes must be a positive integer");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }
  }

  /** Origins the user granted this session. A copy; the guest never sees it. */
  getGrants(): string[] {
    return [...this.grants];
  }

  /** Revoke one session grant. Returns true when a grant was removed. */
  revokeGrant(origin: string): boolean {
    const normalized = normalizeOrigin(origin);
    if (normalized === null) return false;
    return this.grants.delete(normalized);
  }

  clearGrants(): void {
    this.grants.clear();
  }

  /**
   * Fetch a URL's body as text, through the gate. Throws on deny, on an
   * invalid or non-http(s) URL, on any redirect, on timeout, on HTTP
   * errors, and when the body exceeds maxResponseBytes.
   */
  async fetchText(url: string): Promise<string> {
    if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) {
      throw new Error("connection: URL must be a non-empty string under 8 KiB");
    }
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new Error("connection: invalid URL");
    }
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("connection: only http(s) URLs are allowed");
    }
    const origin = current.origin;
    const allowed = this.allowedOrigins.has(origin) || this.grants.has(origin);
    if (!allowed) {
      if (this.onRequest === undefined) {
        throw new Error(`connection denied: ${origin} is not allowed`);
      }
      const decision = await this.onRequest({ url: current.href, origin });
      if (decision === "deny") {
        throw new Error(`connection denied by user: ${origin}`);
      }
      if (decision === "allow-session") {
        this.grants.add(origin);
      } else if (decision !== "allow-once") {
        // Unknown answers fail closed.
        throw new Error(`connection denied: unknown approval decision`);
      }
    }
    let response: Response;
    try {
      response = await this.fetchImpl(current.href, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`connection timed out: ${origin}`);
      }
      throw new Error(
        `connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Browsers hide redirect destinations behind an opaque-redirect
    // response (status 0, empty headers); Node exposes the real 3xx. Both
    // mean the same thing here: rejected, never followed.
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new Error(
        "connection: redirects are not followed; request the final URL directly",
      );
    }
    if (!response.ok) {
      throw new Error(`connection: ${origin} returned HTTP ${response.status}`);
    }
    return this.readCappedText(response, origin);
  }

  private async readCappedText(response: Response, origin: string): Promise<string> {
    const body = response.body;
    if (body !== null && typeof body.getReader === "function") {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            total += value.byteLength;
            if (total > this.maxResponseBytes) {
              try {
                await reader.cancel();
              } catch {
                // ignore
              }
              throw new Error(
                `connection: response from ${origin} exceeds maxResponseBytes`,
              );
            }
            chunks.push(value);
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(merged);
    }
    // Fallback for environments without a readable body stream.
    const text = await response.text();
    if (text.length > this.maxResponseBytes) {
      throw new Error(`connection: response from ${origin} exceeds maxResponseBytes`);
    }
    return text;
  }
}
