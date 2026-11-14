// Spec guard, ported from the legacy Node API's src/lib/spec-guard.ts (on main). Generated specs and page objects run as Node code on the
// platform host, so before any file is stored as valid, exported or executed it is parsed and checked against an
// allow-list: files may drive the browser and read process.env.X, but may not import modules outside the bundle,
// reach Node globals, climb prototypes to recover Function/process, use Playwright's private client internals, or
// pass host file paths to Playwright APIs. This is a guard for a trusted-tenant deployment; the Docker sandbox
// arrives with P5-05.
//
// Changes from the old guard: every problem is reported (not only the first), each with a line number; imports
// may reach the bundle's own platform files, page objects and data factories; `test.use({ trace, video })` with
// literal values is allowed (generated sign-in specs turn traces off); class constructors may be declared (page
// objects), while reading `.constructor` stays blocked.
import { parse, type Node } from "acorn";
import { fullAncestor } from "acorn-walk";
import { transformSync } from "esbuild";

export interface GuardMessage {
  line: number | null;
  message: string;
}

export interface GuardResult {
  ok: boolean;
  messages: GuardMessage[];
}

/** Node globals that give access to the host (only blocked as bare references, not as property names). */
const BLOCKED_GLOBALS = new Set([
  "require", "module", "exports", "global", "globalThis", "eval", "Function", "Reflect", "Proxy", "Object",
  "WebAssembly", "Worker", "SharedArrayBuffer", "Atomics", "Buffer", "__dirname", "__filename", "arguments",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
]); // prettier-ignore

/** Names blocked in any position: prototype escapes and Playwright APIs that read/write host files or launch processes. */
const BLOCKED_NAMES = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "caller", "callee", "prepareStackTrace", "captureStackTrace", "getThis", "getFunction",
  "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "defineProperties",
  "use", "extend", "setInputFiles", "saveAs", "storageState", "routeFromHAR", "recordHar", "recordVideo", "tracing",
  "launch", "launchServer", "launchPersistentContext", "connect", "connectOverCDP", "newCDPSession", "newBrowserCDPSession",
  "launchOptions", "connectOptions", "toMatchSnapshot", "toHaveScreenshot", "toMatchAriaSnapshot", "sendMessageToServer",
]); // prettier-ignore

/** Bundle-relative modules a generated file may import (resolved from the importing file's path). */
const ALLOWED_TARGETS = /^(fixtures|pages\/[A-Za-z][A-Za-z0-9]*|data\/[a-z][a-z0-9-]*)$/;
/** `test.use({...})` options generated specs may set, with literal values only. */
const TEST_USE_OPTIONS: Record<string, Set<string>> = {
  trace: new Set(["off", "on", "retain-on-failure"]),
  video: new Set(["off", "on", "retain-on-failure"]),
};

function nameProblem(name: string): string | null {
  if (BLOCKED_NAMES.has(name)) return `"${name}" is not allowed in test scripts`;
  if (/^_./.test(name)) return `Private names starting with "_" ("${name}") are not allowed in test scripts`;
  if (/path$/i.test(name) || /dir$/i.test(name))
    return `"${name}": scripts cannot pass host file paths or directories to Playwright`;
  return null;
}

type N = Node & Record<string, any>;

const literalKey = (n: N): string | number | null =>
  n.type === "Literal" && (typeof n.value === "string" || typeof n.value === "number")
    ? n.value
    : n.type === "TemplateLiteral" && n.expressions.length === 0
      ? n.quasis[0].value.cooked
      : null;

/** Whether an Identifier is used as a non-computed property/key name rather than a variable reference. */
function isPropertyName(node: N, parent: N | undefined): boolean {
  if (!parent) return false;
  if (parent.type === "MemberExpression") return parent.property === node && !parent.computed;
  if (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition")
    return parent.key === node && !parent.computed && parent.value !== node;
  return false;
}

/** Resolves an import specifier against the importing file's bundle path ("tests/contact/TC-0001.spec.ts"). */
function importTarget(spec: string, filePath: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const parts = filePath.split("/").slice(0, -1);
  for (const seg of spec.replace(/\.(ts|js)$/, "").split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null; // escapes the bundle
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** `test.use({ trace: "off" })`: the only allowed use of the blocked name "use". */
function isAllowedTestUse(member: N, parent: N | undefined): boolean {
  if (!parent || parent.type !== "CallExpression" || parent.callee !== member) return false;
  if (member.object.type !== "Identifier" || member.object.name !== "test" || parent.arguments.length !== 1) return false;
  const arg = parent.arguments[0] as N;
  if (arg.type !== "ObjectExpression" || !arg.properties.length) return false;
  return (arg.properties as N[]).every((p) => {
    if (p.type !== "Property" || p.computed || p.key.type !== "Identifier") return false;
    const allowed = TEST_USE_OPTIONS[p.key.name as string];
    return allowed !== undefined && p.value.type === "Literal" && allowed.has(String(p.value.value));
  });
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Source line (1-based) of each generated line, from an esbuild source map (VLQ "mappings", first segment). */
function originalLines(mapJson: string): number[] {
  let mappings = "";
  try {
    mappings = String((JSON.parse(mapJson) as { mappings?: string }).mappings ?? "");
  } catch {
    return [];
  }
  const out: number[] = [];
  let srcLine = 0;
  for (const lineSegs of mappings.split(";")) {
    let first: number | null = null;
    for (const seg of lineSegs.split(",")) {
      if (!seg) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      if (fields.length >= 3) {
        srcLine += fields[2];
        if (first === null) first = srcLine + 1;
      }
    }
    out.push(first ?? (out.length ? out[out.length - 1] : 1));
  }
  return out;
}

/**
 * Validates one generated file. `filePath` is its path inside the bundle (imports are resolved against it);
 * without one the file is treated as a spec one folder below the bundle root (`tests/x.spec.ts`).
 */
export function checkSpec(code: string, filePath = "tests/spec.spec.ts"): GuardResult {
  const isSpec = /\.spec\.ts$/.test(filePath);
  let js: string;
  let lineMap: number[] = [];
  try {
    // verbatimModuleSyntax keeps unused imports so every import is checked (type-only imports are dropped).
    const out = transformSync(code, {
      loader: "ts",
      format: "esm",
      target: "es2022",
      sourcemap: "external",
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    });
    js = out.code;
    lineMap = originalLines(out.map);
  } catch (err) {
    const e = (err as { errors?: { text: string; location?: { line: number } | null }[] }).errors?.[0];
    return {
      ok: false,
      messages: [
        {
          line: e?.location?.line ?? null,
          message: `Syntax error${e?.location ? ` on line ${e.location.line}` : ""}: ${e?.text ?? (err as Error).message}`,
        },
      ],
    };
  }
  let ast: Node;
  try {
    ast = parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (err) {
    return { ok: false, messages: [{ line: null, message: `Syntax error: ${(err as Error).message}` }] };
  }

  const messages: GuardMessage[] = [];
  fullAncestor(ast, (raw, _state, ancestors) => {
    const node = raw as N;
    const parent = ancestors[ancestors.length - 2] as N | undefined;
    const fail = (msg: string) => {
      const generated = node.loc?.start.line;
      const line = generated === undefined ? null : (lineMap[generated - 1] ?? generated);
      if (!messages.some((m) => m.line === line && m.message === msg)) messages.push({ line, message: msg });
    };
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration": {
        if (!node.source) break;
        const spec = String(node.source.value);
        if (spec === "@playwright/test") {
          if (isSpec) fail('Specs import { test, expect } from the bundle\'s "fixtures", not "@playwright/test"');
          break;
        }
        const target = importTarget(spec, filePath);
        if (target === null || !ALLOWED_TARGETS.test(target))
          fail(`Only the bundle's fixtures, page objects and data factories can be imported, not "${spec}"`);
        break;
      }
      case "ObjectPattern":
        // Destructuring keys ({ constructor: F } = x) are not visited as nodes either.
        for (const p of node.properties as N[]) {
          if (p.type !== "Property") continue;
          const lit = p.computed ? literalKey(p.key) : p.key.type === "Identifier" ? p.key.name : literalKey(p.key);
          const why = lit === null ? "Computed property names must be literals" : nameProblem(String(lit));
          if (why) fail(why);
        }
        break;
      case "ImportExpression":
        fail("Dynamic import() is not allowed");
        break;
      case "MetaProperty":
        if (node.meta.name !== "new") fail("import.meta is not allowed");
        break;
      case "MemberExpression":
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition": {
        const key = node.type === "MemberExpression" ? node.property : node.key;
        if (!node.computed) {
          // The walker does not descend into non-computed property names, so check them here.
          if (node.type === "MemberExpression" && key.type === "Identifier" && key.name === "use" && isAllowedTestUse(node, parent))
            break;
          // A class constructor declaration (page objects) is harmless; reading `.constructor` stays blocked.
          if (node.type === "MethodDefinition" && node.kind === "constructor") break;
          const why =
            key.type === "Identifier" ? nameProblem(key.name) : key.type === "Literal" ? nameProblem(String(key.value)) : null;
          if (why) fail(why);
          break;
        }
        const lit = literalKey(key);
        if (lit === null)
          fail(
            node.type === "MemberExpression"
              ? "Dynamic property access (obj[expr]) is not allowed; use .at(i) for arrays or a literal key"
              : "Computed property names must be literals",
          );
        else if (typeof lit === "string") {
          const why = nameProblem(lit);
          if (why) fail(why);
        }
        break;
      }
      case "Identifier": {
        const name = node.name as string;
        if (name === "use" && parent?.type === "MemberExpression" && parent.property === node && isAllowedTestUse(parent, ancestors[ancestors.length - 3] as N | undefined))
          break;
        const why = nameProblem(name);
        if (why) {
          fail(why);
          break;
        }
        if (isPropertyName(node, parent)) break;
        if (name === "process") {
          // Only process.env.NAME reads are allowed (no writes, no other process APIs).
          const grand = ancestors[ancestors.length - 3] as N | undefined;
          const great = ancestors[ancestors.length - 4] as N | undefined;
          const envRead =
            parent?.type === "MemberExpression" &&
            parent.object === node &&
            !parent.computed &&
            parent.property.name === "env" &&
            grand?.type === "MemberExpression" &&
            grand.object === parent;
          const write =
            great &&
            ((great.type === "AssignmentExpression" && great.left === grand) ||
              great.type === "UpdateExpression" ||
              (great.type === "UnaryExpression" && great.operator === "delete"));
          if (!envRead || write) fail("Only reading process.env.NAME is allowed");
        } else if (BLOCKED_GLOBALS.has(name)) fail(`"${name}" is not available in test scripts`);
        break;
      }
    }
  });
  messages.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { ok: messages.length === 0, messages };
}
