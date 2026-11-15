// Shared helpers for the toolkit tests: a local fixture site, throwaway workspaces under automation/.runs/ and
// a wrapper that calls the CLI the way the backend does.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "qa.mjs");

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** The fixture site: a contact form that (wrongly) accepts an empty Message, a sign-in page and redirects. */
export function startSite(): Promise<{ port: number; url: string; log: string[]; close: () => Promise<void> }> {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    const html = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/contact" && req.method === "POST") {
      req.resume();
      return req.on("end", () => html(200, page("Contact", '<h1>Thank you</h1><p class="success">Message sent</p>')));
    }
    if (u.pathname === "/contact")
      return html(
        200,
        page(
          "Contact",
          '<h1>Contact us</h1><form method="post" action="/contact" aria-label="Contact us">' +
            '<label for="n">Name</label><input id="n" name="name">' +
            '<label for="e">Email</label><input id="e" name="email" type="email">' +
            '<label for="m">Message</label><textarea id="m" name="message"></textarea>' +
            '<button type="submit">Send message</button></form>',
        ),
      );
    if (u.pathname === "/login")
      return html(
        200,
        page(
          "Sign in",
          '<h1>Sign in</h1><form><label for="u">Email</label><input id="u" name="email">' +
            '<label for="p">Password</label><input id="p" name="password" type="password" style="width:300px;height:40px">' +
            "<button>Sign in</button></form>",
        ),
      );
    if (u.pathname === "/vectors") {
      const imgs = u.searchParams.getAll("u").map((v) => `<img alt="" src="${v.replaceAll('"', "&quot;")}">`);
      return html(200, page("Vectors", `<h1>Vectors</h1>${imgs.join("")}`));
    }
    if (u.pathname === "/redirect-private") {
      res.writeHead(302, { location: "http://10.0.0.5/admin" });
      return res.end();
    }
    if (u.pathname === "/redirect-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    if (u.pathname === "/redirect-ok") {
      res.writeHead(302, { location: "/contact" });
      return res.end();
    }
    html(404, page("Not found", "<h1>Not found</h1>"));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        log,
        close: () => new Promise((r) => server.close(() => r())),
      });
    }),
  );
}

/** A fresh workspace under automation/.runs/ (gitignored), with the platform files copied by `qa init`. */
export async function workspace(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(ROOT, ".runs", `test-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const init = await cli(["init", "--dir", dir]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}`);
  for (const [rel, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), code);
  }
  return dir;
}

export function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; json: any }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CI: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", () => undefined);
    child.on("close", (code) => {
      let json: unknown = null;
      try {
        json = JSON.parse(stdout.trim().split("\n").pop() ?? "");
      } catch {
        json = null;
      }
      resolve({ code, stdout, json });
    });
  });
}
