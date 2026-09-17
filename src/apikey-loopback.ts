import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { LoopbackError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PATH = "/connect";
const MAX_BODY_BYTES = 8 * 1024;

export interface ApiKeyLoopbackPage {
  title: string;
  heading: string;
  message: string;
  fieldLabel: string;
  helpUrl?: string;
  helpLabel?: string;
  successText?: string;
  /** Keyless-by-default providers: an empty submission completes the flow and
   * `waitForSecret()` resolves to "" — the caller grants without storing. */
  allowEmpty?: boolean;
  /** Button label for the empty submission (default "Continue without a key"). */
  emptyLabel?: string;
}

export interface ApiKeyLoopbackOptions {
  page: ApiKeyLoopbackPage;
  path?: string;
  timeoutMs?: number;
  now?: () => Date;
  state?: string;
  /** Bind host; default 127.0.0.1. Use 0.0.0.0 behind a reverse proxy. */
  host?: string;
  /** Bind port; default 0 (ephemeral). */
  port?: number;
  /** When set, the advertised url uses `${publicBaseUrl}${path}?state=...`. */
  publicBaseUrl?: string;
}

export class ApiKeyLoopback {
  private closed = false;
  private capturedSettled = false;

  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly expiresAt: Date,
    readonly state: string,
    private readonly captured: Promise<string | { cancelled: true }>,
    private readonly abort: () => void,
  ) {}

  static async start(options: ApiKeyLoopbackOptions): Promise<ApiKeyLoopback> {
    const path = options.path ?? DEFAULT_PATH;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const now = options.now ?? (() => new Date());
    const state = options.state ?? randomBytes(24).toString("base64url");
    const page = options.page;

    const CANCELLED = { cancelled: true as const };
    let resolveSecret!: (value: string | typeof CANCELLED) => void;
    let capturedSettled = false;
    const captured = new Promise<string | typeof CANCELLED>((resolve) => {
      resolveSecret = (value) => {
        if (capturedSettled) {
          return;
        }
        capturedSettled = true;
        resolve(value);
      };
    });

    const settled = { value: false };
    const server = createServer((request, response) => {
      void handleApiKeyRequest(request, response, {
        path,
        page,
        expectedState: state,
        isComplete: () => settled.value,
        resolveSecret,
      }).catch(() => {
        if (!response.writableEnded) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Internal error.");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new LoopbackError("Unable to open a local connect port");
    }

    const publicBase = options.publicBaseUrl?.trim().replace(/\/+$/u, "");
    const origin =
      publicBase !== undefined && publicBase !== ""
        ? publicBase
        : `http://127.0.0.1:${String(address.port)}`;
    const expiresAt = new Date(now().getTime() + timeoutMs);
    const url = `${origin}${path}?state=${encodeURIComponent(state)}`;
    const loopback = new ApiKeyLoopback(server, url, expiresAt, state, captured, () => {
      resolveSecret(CANCELLED);
    });
    const timer = setTimeout(() => {
      loopback.close();
    }, timeoutMs);
    timer.unref();
    void loopback.captured.finally(() => {
      loopback.capturedSettled = true;
      settled.value = true;
      clearTimeout(timer);
    });
    return loopback;
  }

  async waitForSecret(): Promise<string> {
    const value = await this.captured;
    if (typeof value !== "string") {
      throw new LoopbackError("API key connect was cancelled");
    }
    return value;
  }

  close(_error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.server.close();
    if (!this.capturedSettled) {
      this.abort();
    }
  }
}

interface RequestContext {
  path: string;
  page: ApiKeyLoopbackPage;
  expectedState: string;
  isComplete: () => boolean;
  resolveSecret: (value: string) => void;
}

async function handleApiKeyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== context.path) {
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Not found.");
    return;
  }

  // The state in the advertised URL is what makes the page unguessable. Any
  // request without it gets a page that carries no state, so a visitor who
  // only knows the path cannot learn the token and complete the flow.
  if (request.method === "GET" || request.method === "HEAD") {
    if (!statesEqual(url.searchParams.get("state") ?? "", context.expectedState)) {
      writeHtml(response, 403, renderExpired(context.page), request.method === "HEAD");
      return;
    }
    writeHtml(
      response,
      200,
      renderForm(context.page, context.expectedState),
      request.method === "HEAD",
    );
    return;
  }

  if (request.method !== "POST") {
    response.statusCode = 405;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Method not allowed.");
    return;
  }

  const body = await readBody(request);
  const params = new URLSearchParams(body);
  const postedState = params.get("state") ?? url.searchParams.get("state") ?? "";
  if (!statesEqual(postedState, context.expectedState)) {
    writeHtml(response, 403, renderExpired(context.page));
    return;
  }

  const secret = (params.get("api_key") ?? "").trim();
  if (secret.length === 0 && context.page.allowEmpty !== true) {
    writeHtml(
      response,
      400,
      renderForm(context.page, context.expectedState, "Paste a key to continue."),
    );
    return;
  }

  if (!context.isComplete()) {
    context.resolveSecret(secret);
  }
  const success =
    context.page.successText ?? "Key saved to the local vault. You can close this window.";
  writeHtml(response, 200, renderSuccess(context.page, success));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new LoopbackError("Connect form body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeHtml(response: ServerResponse, status: number, html: string, headOnly = false): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (headOnly) {
    response.end();
    return;
  }
  response.end(html);
}

function renderForm(page: ApiKeyLoopbackPage, state: string, error?: string): string {
  const help =
    page.helpUrl !== undefined
      ? `<p><a href="${escapeHtml(page.helpUrl)}" target="_blank" rel="noreferrer">${escapeHtml(page.helpLabel ?? "Get a key")}</a></p>`
      : "";
  const err = error !== undefined ? `<p class="err">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(page.title)}</title>
  <style>
    body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 28rem; margin: 12vh auto; padding: 0 1.25rem; color: #111; }
    h1 { font-size: 1.25rem; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.5rem; font: inherit; margin-top: 0.25rem; }
    button { margin-top: 0.85rem; padding: 0.45rem 0.9rem; font: inherit; }
    .note { color: #555; }
    .err { color: #b91c1c; }
  </style>
</head>
<body>
  <h1>${escapeHtml(page.heading)}</h1>
  <p class="note">${escapeHtml(page.message)}</p>
  ${help}${err}
  <form method="post" action="">
    <input type="hidden" name="state" value="${escapeHtml(state)}"/>
    <label>${escapeHtml(page.fieldLabel)}
      <input type="password" name="api_key" autocomplete="off" autofocus/>
    </label>
    <div><button type="submit">Save to vault</button>${
      page.allowEmpty === true
        ? `<button type="submit" formnovalidate onclick="this.form.api_key.value=''">${escapeHtml(page.emptyLabel ?? "Continue without a key")}</button>`
        : ""
    }</div>
  </form>
  <p class="note">The key is stored locally. It is never sent to chat.</p>
</body>
</html>`;
}

/** Shown to a request that did not carry the expected state. Deliberately
 * form-less: it must never embed the real state. */
function renderExpired(page: ApiKeyLoopbackPage): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(page.title)}</title>
  <style>
    body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 28rem; margin: 12vh auto; padding: 0 1.25rem; color: #111; }
  </style>
</head>
<body>
  <h1>${escapeHtml(page.heading)}</h1>
  <p>This connect page is unknown or has expired. Ask the app for a new link.</p>
</body>
</html>`;
}

function renderSuccess(page: ApiKeyLoopbackPage, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(page.title)}</title>
  <style>
    body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 28rem; margin: 12vh auto; padding: 0 1.25rem; color: #111; }
  </style>
</head>
<body>
  <h1>Connected</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}
