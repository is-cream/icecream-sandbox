import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage } from "../../src/protocol.js";

describe("protocol validation", () => {
  it("round-trips a valid message", () => {
    const raw = encodeMessage({ t: "send", message: "hi" });
    expect(decodeMessage(raw, 1024)).toEqual({ t: "send", message: "hi" });
  });

  it("rejects non-strings, bad JSON, and oversized input", () => {
    expect(decodeMessage(42, 1024)).toBeNull();
    expect(decodeMessage("not json", 1024)).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: "send", message: "x".repeat(2000) }), 1024)).toBeNull();
  });

  it("round-trips the connection messages", () => {
    expect(
      decodeMessage(
        encodeMessage({ t: "connection-request", id: 3, url: "https://a.example/x" }),
        1024,
      ),
    ).toEqual({ t: "connection-request", id: 3, url: "https://a.example/x" });
    expect(
      decodeMessage(encodeMessage({ t: "connection-result", id: 3, value: "css" }), 1024),
    ).toEqual({ t: "connection-result", id: 3, value: "css" });
    expect(
      decodeMessage(encodeMessage({ t: "connection-error", id: 3, error: "denied" }), 1024),
    ).toEqual({ t: "connection-error", id: 3, error: "denied" });
    expect(
      decodeMessage(JSON.stringify({ t: "connection-request", id: 3, url: 42 }), 1024),
    ).toBeNull();
  });

  it("rejects unknown types and wrong field types", () => {
    expect(decodeMessage(JSON.stringify({ t: "pwn" }), 1024)).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: "send", message: 1 }), 1024)).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: "result", id: "1", value: "x" }), 1024)).toBeNull();
    expect(decodeMessage(JSON.stringify(["send"]), 1024)).toBeNull();
  });
});
