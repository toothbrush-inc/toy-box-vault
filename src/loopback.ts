import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { LoopbackError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PATH = "/callback";
const DEFAULT_SUCCESS_TEXT = "Authorization complete. You can close this window.";

export interface LoopbackServerOptions {
  path?: string;
  successText?: string;
  timeoutMs?: number;
  now?: () => Date;
  /** Bind host; default 127.0.0.1. Use 0.0.0.0 behind a reverse proxy. */
  host?: string;
  /** Bind port; default 0 (ephemeral). Fixed ports enable pre-registered public callbacks. */
  port?: number;
  /** When set (e.g. https://gw.example.com), redirectUri advertises `${publicBaseUrl}${path}`. */
  publicBaseUrl?: string;
}

export class LoopbackServer {
  private closed = false;
  private capturedSettled = false;

  private constructor(
    private readonly server: Server,
    readonly redirectUri: string,
    readonly expiresAt: Date,
    private readonly captured: Promise<URLSearchParams>,
    private readonly abort: (error: Error) => void,
  ) {}

  static async start(options: LoopbackServerOptions = {}): Promise<LoopbackServer> {
    const path = options.path ?? DEFAULT_PATH;
    const successText = options.successText ?? DEFAULT_SUCCESS_TEXT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const now = options.now ?? (() => new Date());

    let resolveCaptured!: (value: URLSearchParams) => void;
    let settleAbort!: (error: Error) => void;
    let capturedSettled = false;
    const captured = new Promise<URLSearchParams>((resolve) => {
      resolveCaptured = (value) => {
        if (capturedSettled) {
          return;
        }
        capturedSettled = true;
        resolve(value);
      };
    });
    const aborted = new Promise<never>((_, reject) => {
      settleAbort = reject;
    });
    void aborted.catch(() => undefined);

    const server = createServer((request, response) => {
      handleLoopbackRequest(request, response, path, successText, resolveCaptured);
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
      throw new LoopbackError("Unable to open a local callback port");
    }

    const publicBase = options.publicBaseUrl?.trim().replace(/\/+$/u, "");
    const redirectUri =
      publicBase !== undefined && publicBase !== ""
        ? `${publicBase}${path}`
        : `http://127.0.0.1:${String(address.port)}${path}`;
    const expiresAt = new Date(now().getTime() + timeoutMs);
    const loopback = new LoopbackServer(
      server,
      redirectUri,
      expiresAt,
      Promise.race([captured, aborted]),
      settleAbort,
    );
    const timer = setTimeout(() => {
      loopback.close(new LoopbackError("OAuth callback timed out"));
    }, timeoutMs);
    timer.unref();
    void loopback.captured
      .finally(() => {
        loopback.capturedSettled = true;
        clearTimeout(timer);
      })
      .catch(() => undefined);
    return loopback;
  }

  waitForParams(): Promise<URLSearchParams> {
    return this.captured;
  }

  close(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.server.close();
    if (!this.capturedSettled) {
      this.abort(error ?? new LoopbackError("OAuth callback was cancelled"));
    }
  }
}

function handleLoopbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  successText: string,
  resolveCaptured: (value: URLSearchParams) => void,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end("Method not allowed.");
    return;
  }
  if (url.pathname !== path) {
    response.statusCode = 404;
    response.end("Not found.");
    return;
  }
  if (request.method === "HEAD") {
    response.statusCode = 200;
    response.end();
    return;
  }

  resolveCaptured(url.searchParams);
  response.end(successText);
}
