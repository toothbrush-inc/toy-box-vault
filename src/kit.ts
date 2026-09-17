// Capability kit: the higher-level helpers every capability was copy-pasting.
// Imported via the "local-toy-vault/kit" subpath. The core vault stays low-level;
// this module makes the conventions executable: the typed result envelope,
// payload sanitization, and the standalone/brokered/broker-only ladders for
// profile and commons access.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  brokeredCall,
  brokeredCommons,
  brokeredProfile,
  egressFromEnv,
  type BrokeredCallResult,
  type PeerProvenance,
} from "./egress.js";
import { withCallContext } from "./call-context.js";
import { openVault } from "./vault.js";

// ---------------------------------------------------------------- results --

export interface ToolResultContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  structuredContent: unknown;
  isError?: true;
}

const FORBIDDEN_KEYS = new Set([
  "apikey",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "secret",
  "client_secret",
  "authorization",
]);

const TOKEN_LIKE = /\b(?:ya29\.[\w.-]+|1\/\/[0-9A-Za-z_-]{8,}|(?:sk|pk)_live_[0-9A-Za-z]+)\b/gu;

/** Strips credential-shaped keys and redacts token-shaped strings. */
export function sanitizeToolPayload(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(TOKEN_LIKE, "[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeToolPayload(entry));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        continue;
      }
      out[key] = sanitizeToolPayload(entry);
    }
    return out;
  }
  return value;
}

export function ok(data: unknown): { ok: true; data: unknown } {
  return { ok: true, data };
}

export function fail(
  error: unknown,
  code: string,
): { ok: false; error: { code: string; message: string } } {
  const withCode = error as { code?: unknown; message?: unknown };
  return {
    ok: false,
    error: {
      code: typeof withCode?.code === "string" ? withCode.code : code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/** The platform result envelope: sanitized typed JSON, isError on {ok:false}. */
export function jsonResult(payload: unknown): ToolResult {
  const clean = sanitizeToolPayload(JSON.parse(JSON.stringify(payload)));
  const failed = (clean as { ok?: unknown } | null)?.ok === false;
  return {
    content: [{ type: "text", text: JSON.stringify(clean) }],
    structuredContent: clean,
    ...(failed ? { isError: true as const } : {}),
  };
}

// ---------------------------------------------------------------- profile --

export interface ProfileContext {
  values: Record<string, string>;
  source: "profile" | "default";
  note?: string;
}

/**
 * The profile ladder in one call: brokered under a gateway, direct grant-gated
 * read standalone, and defaults (with an actionable note) when ungranted or
 * under broker-only mode without egress. Never throws.
 */
export async function profileContext(
  capabilityId: string,
  fields: readonly string[],
  defaults: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileContext> {
  let got: Record<string, string>;
  try {
    const egress = egressFromEnv(env);
    got = egress
      ? await brokeredProfile(egress, { fields })
      : await openVault({ env }).getProfileFor(capabilityId, fields);
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error as { name?: string }).name;
    const note =
      code === "grant_missing" || code === "GrantError" || code === "EgressRequiredError"
        ? `profile fields ${fields.join("/")} are not granted to ${capabilityId}; grant profile:default to personalize`
        : `profile unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return { values: { ...defaults }, source: "default", note };
  }
  if (Object.keys(got).length === 0) {
    return { values: { ...defaults }, source: "default" };
  }
  return { values: { ...defaults, ...got }, source: "profile" };
}

// ------------------------------------------------------------------ peers --

export interface PeerCallResult {
  ok: boolean;
  /** The producer envelope's `data` on success (or its raw result if untyped). */
  data?: unknown;
  error?: { code: string; message: string };
  provenance?: PeerProvenance;
  note?: string;
}

/**
 * Calls another capability's tool through the gateway broker. Declare the peer
 * in your manifest ({provider: "capability", slot: "<producer>", actions:
 * [tools...]}); the user grants it via gateway_grant. Never throws: standalone
 * (no broker) and denials come back as {ok: false} with an actionable note —
 * degrade gracefully, exactly like profileContext.
 */
export async function peerCall(
  producer: string,
  tool: string,
  args: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<PeerCallResult> {
  const egress = egressFromEnv(env);
  if (!egress) {
    return {
      ok: false,
      error: {
        code: "peer_unavailable",
        message: `calls to ${producer} are only available under the gateway broker`,
      },
      note: `run under the gateway to call ${producer}; degrade gracefully standalone`,
    };
  }
  let brokered: BrokeredCallResult;
  try {
    brokered = await brokeredCall(egress, { capability: producer, tool, args });
  } catch (error) {
    const code = (error as { code?: string }).code ?? "egress_error";
    const out: PeerCallResult = {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
    if (code === "grant_missing") {
      out.note = `access to ${producer} is not granted; grant capability:${producer} to enable`;
    }
    return out;
  }
  const envelope = brokered.result as { ok?: unknown; data?: unknown; error?: unknown } | null;
  if (envelope !== null && typeof envelope === "object" && envelope.ok === true) {
    return { ok: true, data: envelope.data, provenance: brokered.provenance };
  }
  if (envelope !== null && typeof envelope === "object" && envelope.ok === false) {
    const err = envelope.error as { code?: unknown; message?: unknown } | undefined;
    return {
      ok: false,
      error: {
        code: typeof err?.code === "string" ? err.code : "peer_error",
        message:
          typeof err?.message === "string" ? err.message : `call to ${producer}.${tool} failed`,
      },
      provenance: brokered.provenance,
    };
  }
  return { ok: true, data: brokered.result, provenance: brokered.provenance };
}

// ---------------------------------------------------------------- commons --

const COMMONS_DATASET_NAME = /^[a-z][a-z0-9_-]*$/u;

export interface CommonsResult {
  data: unknown;
  source: "broker" | "dir" | "bundled" | "none";
}

/**
 * The commons ladder in one call: broker under a gateway, a COMMONS_DIR file
 * standalone, then the bundled fallback. Never throws; source "none" when
 * everything failed — the capability must keep working anyway.
 */
export async function commonsDataset(
  dataset: string,
  options: { bundled?: unknown | (() => unknown); env?: NodeJS.ProcessEnv } = {},
): Promise<CommonsResult> {
  const env = options.env ?? process.env;
  // Same rule the manifest applies to `data.commons[].dataset`. The name is
  // joined into a path below, so anything else (`../x`, `/etc/x`) must not
  // reach the broker or the filesystem; it can still fall to the bundled copy.
  const named = COMMONS_DATASET_NAME.test(dataset);
  const egress = named ? egressFromEnv(env) : null;
  if (egress) {
    try {
      return { data: await brokeredCommons(egress, { dataset }), source: "broker" };
    } catch {
      // fall through the ladder
    }
  }
  const dir = env["COMMONS_DIR"];
  if (named && dir !== undefined && dir.trim() !== "") {
    try {
      return { data: JSON.parse(readFileSync(join(dir, `${dataset}.json`), "utf8")), source: "dir" };
    } catch {
      // fall through
    }
  }
  if (options.bundled !== undefined) {
    try {
      const bundled =
        typeof options.bundled === "function" ? (options.bundled as () => unknown)() : options.bundled;
      return { data: bundled, source: "bundled" };
    } catch {
      // fall through
    }
  }
  return { data: null, source: "none" };
}

// ----------------------------------------------------------- call scope --

/** Key the gateway sets in a forwarded call's `_meta` to name the caller. */
export const CALL_NONCE_META_KEY = "callNonce";

type ToolHandler = (...args: unknown[]) => unknown;

interface ToolRegistrar {
  registerTool: (name: string, config: unknown, handler: ToolHandler) => unknown;
}

function hasRegisterTool(value: unknown): value is ToolRegistrar {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { registerTool?: unknown }).registerTool === "function"
  );
}

function nonceFrom(extra: unknown): string | undefined {
  if (typeof extra !== "object" || extra === null) {
    return undefined;
  }
  const meta = (extra as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) {
    return undefined;
  }
  const nonce = (meta as Record<string, unknown>)[CALL_NONCE_META_KEY];
  return typeof nonce === "string" && nonce !== "" ? nonce : undefined;
}

/**
 * Makes every tool this server registers run inside the caller's context, so
 * `profileContext` and the brokered helpers resolve the right user with no
 * per-tool wiring. Call it once, before registering tools:
 *
 *     const server = withCallScope(new McpServer({ ... }));
 *
 * Standalone (no gateway, no `_meta`) the handler runs unwrapped, so a
 * capability behaves identically on its own — the contract's standalone rule.
 *
 * Because the context is ambient rather than a handler argument, **per-user
 * state must never be cached in module scope**: one process serves everyone,
 * and a module-level value would outlive the call that set it.
 */
export function withCallScope<T>(server: T): T {
  if (!hasRegisterTool(server)) {
    throw new TypeError("withCallScope: expected an MCP server exposing registerTool");
  }
  const register = server.registerTool.bind(server);
  server.registerTool = (name: string, config: unknown, handler: ToolHandler): unknown =>
    register(name, config, (...args: unknown[]): unknown => {
      // The SDK passes `extra` last, with or without a leading args object.
      const nonce = nonceFrom(args[args.length - 1]);
      return nonce === undefined
        ? handler(...args)
        : withCallContext({ callNonce: nonce }, () => handler(...args));
    });
  return server;
}
