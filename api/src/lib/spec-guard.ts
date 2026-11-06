import { parse, type Node } from "acorn";
import { fullAncestor } from "acorn-walk";
import { transformSync } from "esbuild";

// Specs run as Node code on the platform host, so before any spec is saved, exported or executed
// it is parsed and checked against an allow-list: tests may drive the browser and read
// process.env.X, but may not import modules, reach Node globals, climb prototypes to recover
// Function/process, use Playwright's private client internals, or pass host file paths to
// Playwright APIs. This is a guard for a trusted-tenant deployment; hosted multi-tenant
// deployments should still run the runner in a container or VM (see README).

export type SpecCheck = { ok: true } | { ok: false; error: string };

const ALLOWED_IMPORTS = new Set(["../fixtures", "./fixtures", "@playwright/test"]);

/** Node globals that give access to the host (only blocked as bare references, not as property names). */
const BLOCKED_GLOBALS = new Set([
  "require", "module", "exports", "global", "globalThis", "eval", "Function", "Reflect", "Proxy", "Object",
  "WebAssembly", "Worker", "SharedArrayBuffer", "Atomics", "Buffer", "__dirname", "__filename", "arguments",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
]);

/** Names blocked in any position: prototype escapes and Playwright APIs that read/write host files or launch processes. */
const BLOCKED_NAMES = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "caller", "callee", "prepareStackTrace", "captureStackTrace", "getThis", "getFunction",
  "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "defineProperties",
  "use", "extend", "setInputFiles", "saveAs", "storageState", "routeFromHAR", "recordHar", "recordVideo", "tracing",
  "launch", "launchServer", "launchPersistentContext", "connect", "connectOverCDP", "newCDPSession", "newBrowserCDPSession",
  "launchOptions", "connectOptions", "toMatchSnapshot", "toHaveScreenshot", "toMatchAriaSnapshot", "sendMessageToServer",
]);

function nameProblem(name: string): string | null {
  if (BLOCKED_NAMES.has(name)) return `"${name}" is not allowed in test scripts`;
  if (/^_./.test(name)) return `Private names starting with "_" ("${name}") are not allowed in test scripts`;
  if (/path$/i.test(name) || /dir$/i.test(name)) return `"${name}": scripts cannot pass host file paths or directories to Playwright`;
  return null;
}

type N = Node & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const literalKey = (n: N): string | number | null =>
  n.type === "Literal" && (typeof n.value === "string" || typeof n.value === "number") ? n.value
  : n.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked
  : null;

/** Whether an Identifier is used as a non-computed property/key name rather than a variable reference. */
function isPropertyName(node: N, parent: N | undefined) {
  if (!parent) return false;
  if (parent.type === "MemberExpression") return parent.property === node && !parent.computed;
  if (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") return parent.key === node && !parent.computed && parent.value !== node;
  return false;
}

/** Validates a spec's source. Returns a readable reason (with line number) when it is rejected. */
export function checkSpec(code: string): SpecCheck {
  let js: string;
  try {
    // verbatimModuleSyntax keeps unused imports so every import is checked.
    js = transformSync(code, { loader: "ts", format: "esm", target: "es2022", tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } }).code;
  } catch (err) {
    const e = (err as { errors?: { text: string; location?: { line: number; column: number } | null }[] }).errors?.[0];
    return { ok: false, error: `Syntax error${e?.location ? ` on line ${e.location.line}` : ""}: ${e?.text ?? (err as Error).message}` };
  }
  let ast: Node;
  try {
    ast = parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (err) {
    return { ok: false, error: `Syntax error: ${(err as Error).message}` };
  }

  let problem: string | null = null;
  fullAncestor(ast, (raw, _state, ancestors) => {
    if (problem) return;
    const node = raw as N;
    const parent = ancestors[ancestors.length - 2] as N | undefined;
    const fail = (msg: string) => (problem = `${msg} (line ${node.loc?.start.line ?? "?"})`);
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
        if (node.source && !ALLOWED_IMPORTS.has(String(node.source.value))) fail(`Only "../fixtures" or "@playwright/test" can be imported, not "${node.source.value}"`);
        break;
      case "ObjectPattern":
        // Destructuring keys ({ constructor: F } = x) are not visited as nodes either.
        for (const p of node.properties as N[]) {
          if (p.type !== "Property") continue;
          const lit = p.computed ? literalKey(p.key) : p.key.type === "Identifier" ? p.key.name : literalKey(p.key);
          const why = lit === null ? "Computed property names must be literals" : nameProblem(String(lit));
          if (why) return void fail(why);
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
        const computed = node.computed;
        const key = node.type === "MemberExpression" ? node.property : node.key;
        if (!computed) {
          // The walker does not descend into non-computed property names, so check them here.
          const why = key.type === "Identifier" ? nameProblem(key.name) : key.type === "Literal" ? nameProblem(String(key.value)) : null;
          if (why) fail(why);
          break;
        }
        const lit = literalKey(key);
        if (lit === null) fail(node.type === "MemberExpression" ? "Dynamic property access (obj[expr]) is not allowed; use .at(i) for arrays or a literal key" : "Computed property names must be literals");
        else if (typeof lit === "string") {
          const why = nameProblem(lit);
          if (why) fail(why);
        }
        break;
      }
      case "Identifier": {
        const name = node.name as string;
        const why = nameProblem(name);
        if (why) return void fail(why);
        if (isPropertyName(node, parent)) return;
        if (name === "process") {
          // Only process.env.NAME reads are allowed (no writes, no other process APIs).
          const grand = ancestors[ancestors.length - 3] as N | undefined;
          const great = ancestors[ancestors.length - 4] as N | undefined;
          const envRead = parent?.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.name === "env"
            && grand?.type === "MemberExpression" && grand.object === parent;
          const write = great && ((great.type === "AssignmentExpression" && great.left === grand) || great.type === "UpdateExpression" || (great.type === "UnaryExpression" && great.operator === "delete"));
          if (!envRead || write) fail("Only reading process.env.NAME is allowed");
        } else if (BLOCKED_GLOBALS.has(name)) fail(`"${name}" is not available in test scripts`);
        break;
      }
    }
  });
  return problem ? { ok: false, error: problem } : { ok: true };
}
