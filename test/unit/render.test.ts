import { describe, it, expect } from "vitest";
import { sanitizeCss, validateTree } from "../../src/render.js";

describe("sanitizeCss", () => {
  it("keeps ordinary rules", () => {
    expect(sanitizeCss("p { color: red; margin: 0; }")).toContain("color: red");
  });

  it("strips comments", () => {
    expect(sanitizeCss("/* hidden */ p { color: red; }")).not.toContain("hidden");
    expect(sanitizeCss("/* hidden */ p { color: red; }")).toContain("color: red");
  });

  it("removes @import in url and string forms", () => {
    const css = `@import url("https://evil.example/a.css"); @import "https://evil.example/b.css"; p { color: red; }`;
    const out = sanitizeCss(css);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@import");
    expect(out).toContain("color: red");
  });

  it("replaces url() with none so no fetch can happen", () => {
    const css = `div { background-image: url("https://evil.example/p.png"); }`;
    const out = sanitizeCss(css);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("url(");
    expect(out).toContain("none");
  });

  it("rejects non-strings", () => {
    expect(() => sanitizeCss(42 as unknown as string)).toThrow(/must be a string/);
  });
});

describe("validateTree", () => {
  it("accepts text, numbers, and element trees", () => {
    expect(() =>
      validateTree({
        type: "div",
        props: { className: "app" },
        children: ["hello ", 42, { type: "button", props: { onClick: "inc" }, children: ["+"] }],
      }),
    ).not.toThrow();
  });

  it("rejects disallowed tags", () => {
    expect(() => validateTree({ type: "script", children: ["alert(1)"] })).toThrow(/disallowed/);
    expect(() => validateTree({ type: "iframe" })).toThrow(/disallowed/);
    expect(() => validateTree({ type: "form" })).toThrow(/disallowed/);
    expect(() => validateTree({ type: "style", children: ["p{}"] })).toThrow(/disallowed/);
  });

  it("rejects malformed shapes", () => {
    expect(() => validateTree(null)).toThrow();
    expect(() => validateTree({ type: 42 })).toThrow();
    expect(() => validateTree({ type: "div", props: "nope" })).toThrow();
    expect(() => validateTree({ type: "div", children: "nope" })).toThrow();
    expect(() => validateTree({ type: "button", props: { onClick: 42 } })).toThrow();
    expect(() => validateTree({ type: "div", props: { title: { nested: true } } })).toThrow();
  });

  it("rejects over-deep and over-large trees", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { type: "div", children: [deep] };
    expect(() => validateTree(deep)).toThrow(/depth/);
    const wide = { type: "div", children: Array.from({ length: 5001 }, () => "x") };
    expect(() => validateTree(wide)).toThrow(/nodes/);
  });
});
