/**
 * Unit tests for guest ES module imports: the scanner, the resolver,
 * the host-side cache, and real module execution through GuestRunner
 * with the genuine d3-format build (vendored in examples/vendor).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ImportCache,
  isModuleCode,
  resolveSpecifier,
  scanDynamicImportSpecifiers,
  scanModuleSpecifiers,
  validateImportMap,
} from "../../src/imports.js";
import { GuestRunner } from "../../src/guest-runner.js";
import { encodeMessage, decodeMessage } from "../../src/protocol.js";
import { resolveLimits } from "../../src/limits.js";

const D3_FORMAT = readFileSync(
  join(__dirname, "../../examples/vendor/d3-format.mjs"),
  "utf8",
);

describe("scanModuleSpecifiers minified forms", () => {
  it("finds imports with no space after from (minified bundles)", () => {
    // Real packages ship minified: Chart.js's bundle writes
    // from"/npm/@kurkle/color@0.3.4/+esm".
    const code = `import{Chart as C}from"chart";import"x";export{a as b}from"y";`;
    expect(scanModuleSpecifiers(code)).toEqual(["chart", "x", "y"]);
  });

  it("still skips comments, strings, and non-import words", () => {
    const code = `// import"nope";\nconst s = "from\\"nope2\\"";\nconst important = 1;\nimport{o}from"yes";`;
    expect(scanModuleSpecifiers(code)).toEqual(["yes"]);
  });
});

describe("scanDynamicImportSpecifiers", () => {
  it("finds every static import form", () => {
    const code = `
      import def from 'a';
      import { x, y } from "b";
      import * as ns from 'c';
      import 'd';
      import {
        multi,
        line,
      } from 'e';
      export { z } from 'f';
      export * from "g";
    `;
    expect(scanModuleSpecifiers(code)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("ignores imports inside comments and strings", () => {
    const code = `
      // import fake from 'nope';
      /* import alsoFake from "nope2"; */
      const s = "import stringy from 'nope3';";
      const t = 'import single from "nope4";';
      import real from 'yes';
    `;
    expect(scanModuleSpecifiers(code)).toEqual(["yes"]);
  });

  it("dedupes while keeping first-seen order", () => {
    expect(
      scanModuleSpecifiers(`import a from 'x'; import b from 'y'; import c from 'x';`),
    ).toEqual(["x", "y"]);
  });

  it("returns [] for classic scripts", () => {
    expect(scanModuleSpecifiers(`host.send("hi"); "done"`)).toEqual([]);
    expect(scanModuleSpecifiers(`const s = "import not from 'real'";`)).toEqual([]);
  });
});

describe("scanModuleSpecifiers", () => {
  it("finds string-literal dynamic imports", () => {
    const code = `
      const a = await import('x');
      const b = await import("y");
      const c = await import(
        'z'
      );
    `;
    expect(scanDynamicImportSpecifiers(code)).toEqual(["x", "y", "z"]);
  });

  it("ignores computed specifiers, templates, comments, and strings", () => {
    const code = `
      const a = await import(name);
      const b = await import(\`./\${name}.mjs\`);
      // const c = await import('nope');
      const s = "await import('nope2');";
      import staticName from 'static';
    `;
    expect(scanDynamicImportSpecifiers(code)).toEqual([]);
  });

  it("dedupes while keeping first-seen order", () => {
    expect(
      scanDynamicImportSpecifiers(`await import('x'); await import('y'); await import('x');`),
    ).toEqual(["x", "y"]);
  });
});

describe("isModuleCode", () => {
  it("detects module syntax and ignores lookalikes", () => {
    expect(isModuleCode(`import x from 'y';`)).toBe(true);
    expect(isModuleCode(`export const x = 1;`)).toBe(false);
    expect(isModuleCode(`host.send("hi"); "done"`)).toBe(false);
    expect(isModuleCode(`// import x from 'y';`)).toBe(false);
  });
});

describe("resolveSpecifier", () => {
  const map = { "d3-format": "https://cdn.jsdelivr.net/npm/d3-format@3.1.2/+esm" };

  it("resolves bare specifiers through the import map", () => {
    expect(resolveSpecifier("d3-format", null, map)).toBe(
      "https://cdn.jsdelivr.net/npm/d3-format@3.1.2/+esm",
    );
  });

  it("rejects unmapped bare specifiers by name", () => {
    expect(() => resolveSpecifier("nope", null, map)).toThrow(/unknown import "nope"/);
  });

  it("resolves relatives against the importing module's URL", () => {
    expect(
      resolveSpecifier(
        "./d3-format.mjs",
        "https://canary.example/mod-wrapper.mjs",
        map,
      ),
    ).toBe("https://canary.example/d3-format.mjs");
    expect(
      resolveSpecifier(
        "../lib/util.mjs",
        "https://canary.example/deep/mod.mjs",
        map,
      ),
    ).toBe("https://canary.example/lib/util.mjs");
  });

  it("rejects relative imports from the entry module", () => {
    expect(() => resolveSpecifier("./x.mjs", null, map)).toThrow(/only supported inside fetched modules/);
  });

  it("passes absolute http(s) URLs through and rejects other schemes", () => {
    expect(resolveSpecifier("https://example.com/m.mjs", null, map)).toBe(
      "https://example.com/m.mjs",
    );
    expect(() => resolveSpecifier("file:///etc/passwd", null, map)).toThrow(/http\(s\)/);
    expect(() => resolveSpecifier("javascript:alert(1)", null, map)).toThrow(/http\(s\)/);
  });
});

describe("validateImportMap", () => {
  it("accepts a well-formed map and rejects bad entries", () => {
    expect(validateImportMap({ a: "https://example.com/a.mjs" })).toEqual({
      a: "https://example.com/a.mjs",
    });
    expect(() => validateImportMap({ a: "file:///x" })).toThrow();
    expect(() => validateImportMap({ a: 42 })).toThrow();
    expect(() => validateImportMap("nope")).toThrow();
  });
});

describe("ImportCache", () => {
  it("stores, reports, and clears sources", () => {
    const cache = new ImportCache();
    expect(cache.size).toBe(0);
    cache.set("https://example.com/a.mjs", "export const a = 1;");
    expect(cache.get("https://example.com/a.mjs")).toBe("export const a = 1;");
    expect(cache.has("https://example.com/a.mjs")).toBe(true);
    expect(cache.keys()).toEqual(["https://example.com/a.mjs"]);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

/**
 * Drive GuestRunner directly with a fake host port: it answers
 * import-requests from a local map using the exact messages the real
 * Session sends, and captures the run's result/error reply.
 */
async function driveModule(
  code: string,
  hostModules: Record<string, string>,
  importMap: Record<string, string>,
): Promise<{ messages: string[]; result: string }> {
  const messages: string[] = [];
  let runner: GuestRunner | null = null;
  let settleRun: (outcome: { ok: boolean; value: string }) => void = () => undefined;
  const outcome = new Promise<{ ok: boolean; value: string }>((resolve) => {
    settleRun = resolve;
  });
  const sendRaw = (raw: string): void => {
    const decoded = decodeMessage(raw, 8 * 1024 * 1024);
    if (decoded === null) return;
    if (decoded.t === "message") {
      messages.push(decoded.message);
      return;
    }
    if (decoded.t === "result") {
      settleRun({ ok: true, value: decoded.value });
      return;
    }
    if (decoded.t === "error") {
      settleRun({ ok: false, value: decoded.error });
      return;
    }
    if (decoded.t === "import-request") {
      const source = hostModules[decoded.url];
      // Answer asynchronously, like a real port round trip.
      setTimeout(() => {
        runner?.handleMessage(
          encodeMessage(
            source !== undefined
              ? { t: "import-result", id: decoded.id, value: source }
              : { t: "import-error", id: decoded.id, error: `not found: ${decoded.url}` },
          ),
        );
      }, 0);
    }
  };
  runner = await GuestRunner.create(sendRaw);
  try {
    runner.handleMessage(
      encodeMessage({
        t: "run",
        id: 1,
        code,
        limits: resolveLimits({ deadlineMs: 10000 }),
        imports: importMap,
      }),
    );
    const settled = await outcome;
    if (!settled.ok) throw new Error(settled.value);
    return { messages, result: settled.value };
  } finally {
    runner.dispose();
  }
}

const D3_URL = "https://cdn.example/d3-format.mjs";
const D3_MAP = { "d3-format": D3_URL };

describe("GuestRunner module execution (real d3-format)", () => {
  it("imports the real d3-format and uses format() for real output", async () => {
    const { messages, result } = await driveModule(
      `import { format } from 'd3-format';
       host.send(format('.2f')(3.14159));`,
      { [D3_URL]: D3_FORMAT },
      D3_MAP,
    );
    // Real computed output from the genuine published build, not a stub.
    expect(messages).toEqual(["3.14"]);
    expect(result).toBe("");
  });

  it("top-level await works in module scope; output still flows via host.send", async () => {
    // A module's evaluation promise fulfills with its namespace, never
    // with an awaited value — so module output travels via host.send,
    // and a synchronously-finishing module run resolves to "".
    const { messages, result } = await driveModule(
      `import { format } from 'd3-format';
       const out = await Promise.resolve(format('.0f')(42));
       host.send(out);`,
      { [D3_URL]: D3_FORMAT },
      D3_MAP,
    );
    expect(messages).toEqual(["42"]);
    expect(result).toBe("");
  });

  it("an unmapped import fails the run naming the specifier", async () => {
    await expect(
      driveModule(`import { x } from 'nope'; host.send("never");`, {}, {}),
    ).rejects.toThrow(/unknown import "nope"/);
  });

  it("a denied import fails the run with the host's error", async () => {
    await expect(
      driveModule(
        `import { format } from 'd3-format'; host.send("never");`,
        {},
        D3_MAP,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("a classic script without imports still behaves exactly as before", async () => {
    const { messages, result } = await driveModule(
      `host.send("hi"); "done"`,
      {},
      {},
    );
    expect(messages).toEqual(["hi"]);
    expect(result).toBe("done");
  });

  it("transitive relative imports resolve against the importing module", async () => {
    const wrapperUrl = "https://cdn.example/wrapper.mjs";
    const { messages } = await driveModule(
      `import { format } from 'wrapper';
       host.send(format(',.0f')(1234567));`,
      {
        [wrapperUrl]: `export { format } from './d3-format.mjs';`,
        [D3_URL]: D3_FORMAT,
      },
      { wrapper: wrapperUrl },
    );
    expect(messages).toEqual(["1,234,567"]);
  });
});

describe("GuestRunner dynamic imports", () => {
  it("a classic script keeps its result while lazy-loading a module", async () => {
    // Classic semantics preserved: the IIFE's return value is still the
    // run result, even though the run also used import().
    const { messages, result } = await driveModule(
      `(async () => {
         const { format } = await import('d3-format');
         host.send(format('.2f')(3.14159));
         return "done";
       })()`,
      { [D3_URL]: D3_FORMAT },
      D3_MAP,
    );
    expect(messages).toEqual(["3.14"]);
    expect(result).toBe("done");
  });

  it("downloaded, then re-rendered: loading message first, formatted second", async () => {
    const { messages } = await driveModule(
      `(async () => {
         host.send("loading…");
         const { format } = await import('d3-format');
         host.send("formatted: " + format('.0f')(42));
         return "done";
       })()`,
      { [D3_URL]: D3_FORMAT },
      D3_MAP,
    );
    expect(messages).toEqual(["loading…", "formatted: 42"]);
  });

  it("a module guest can dynamic-import too (top-level await)", async () => {
    const { messages } = await driveModule(
      `import { format as staticFormat } from 'd3-format';
       const { format } = await import('d3-format');
       host.send(staticFormat('.1f')(1.25) + "/" + format('.1f')(2.25));`,
      { [D3_URL]: D3_FORMAT },
      D3_MAP,
    );
    expect(messages).toEqual(["1.3/2.3"]);
  });

  it("host.importModule loads a computed name and resolves with the namespace", async () => {
    const { messages } = await driveModule(
      `(async () => {
         const name = 'd3-format';
         const mod = await host.importModule(name);
         host.send(mod.format('.2f')(1.5));
         return "done";
       })()`,
      { [D3_URL]: D3_FORMAT },
      D3_MAP,
    );
    expect(messages).toEqual(["1.50"]);
  });

  it("host.importModule resolves only map keys, never arbitrary names", async () => {
    await expect(
      driveModule(
        `(async () => { await host.importModule('evil'); })()`,
        {},
        D3_MAP,
      ),
    ).rejects.toThrow(/unknown import "evil"/);
  });

  it("host.importModule follows transitive deps of the loaded module", async () => {
    const wrapperUrl = "https://cdn.example/wrapper.mjs";
    const { messages } = await driveModule(
      `(async () => {
         const mod = await host.importModule('wrapper');
         host.send(mod.format(',.0f')(1234567));
         return "done";
       })()`,
      {
        [wrapperUrl]: `export { format } from './d3-format.mjs';`,
        [D3_URL]: D3_FORMAT,
      },
      { wrapper: wrapperUrl },
    );
    expect(messages).toEqual(["1,234,567"]);
  });

  it("host.importModule waits for the module's top-level await", async () => {
    const tlaUrl = "https://cdn.example/tla.mjs";
    const { messages } = await driveModule(
      `(async () => {
         const mod = await host.importModule('tla');
         host.send("value=" + mod.value);
         return "done";
       })()`,
      { [tlaUrl]: `await Promise.resolve(); export const value = 7;` },
      { tla: tlaUrl },
    );
    expect(messages).toEqual(["value=7"]);
  });

  it("a computed import() of a not-yet-downloaded module fails naming it", async () => {
    // QuickJS replaces dynamic-import load failures with its own
    // generic text (the normalizer's guidance never surfaces here),
    // so the failure names the module and nothing else. The
    // documented path for a computed name is host.importModule (see
    // the test above it), which downloads at call time.
    await expect(
      driveModule(
        `(async () => {
           const name = 'd3-format';
           await import(name);
         })()`,
        { [D3_URL]: D3_FORMAT },
        D3_MAP,
      ),
    ).rejects.toThrow(/could not load module 'd3-format'/);
  });

  it("static import of the real Chart.js bundle (with a transitive dep)", async () => {
    // chart.js's bundle imports /npm/@kurkle/color@0.3.4/+esm — a
    // path-absolute specifier that resolves against the importing
    // module's origin and downloads through the gate like any hop.
    const CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.6.1/+esm";
    const COLOR_URL = "https://cdn.jsdelivr.net/npm/@kurkle/color@0.3.4/+esm";
    const { messages } = await driveModule(
      `import { Chart } from 'chart.js';
       host.send(Chart.version + "/" + typeof Chart.register);`,
      {
        [CHART_URL]: readFileSync(
          new URL("../../examples/vendor/chart.js.mjs", import.meta.url),
          "utf8",
        ),
        [COLOR_URL]: readFileSync(
          new URL("../../examples/vendor/kurkle-color.mjs", import.meta.url),
          "utf8",
        ),
      },
      { "chart.js": CHART_URL },
    );
    expect(messages).toEqual(["4.6.1/function"]);
  });

  it("dynamic import of the real Chartist bundle by computed name", async () => {
    const CHARTIST_URL = "https://cdn.jsdelivr.net/npm/chartist@1.3.1/+esm";
    const { messages } = await driveModule(
      `(async () => {
         const name = 'chartist';
         const mod = await host.importModule(name);
         host.send(mod.sum(19, 23) + "/" + typeof mod.LineChart);
         return "done";
       })()`,
      {
        [CHARTIST_URL]: readFileSync(
          new URL("../../examples/vendor/chartist.mjs", import.meta.url),
          "utf8",
        ),
      },
      { chartist: CHARTIST_URL },
    );
    expect(messages).toEqual(["42/function"]);
  });

  it("a computed import() works once the module is already downloaded", async () => {
    // The literal import up front downloads the module; the computed
    // import later resolves from the same pre-fetched map.
    const { messages } = await driveModule(
      `(async () => {
         const { format: f1 } = await import('d3-format');
         host.send(f1('.1f')(1.25));
         const name = 'd3-format';
         const { format: f2 } = await import(name);
         host.send(f2('.1f')(2.25));
         return "done";
       })()`,
      { [D3_URL]: D3_FORMAT },
      D3_MAP,
    );
    expect(messages).toEqual(["1.3", "2.3"]);
  });
});
