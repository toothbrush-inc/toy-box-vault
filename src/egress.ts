// Client side of brokered egress. A gateway/broker hands a capability its
// endpoint via VAULT_EGRESS_URL + VAULT_EGRESS_TOKEN; credentialed requests go
// through the broker, which owns credential attachment and host allowlists.
// This client stays generic: it never parses upstream bodies or shapes
// capability-specific errors.

export interface EgressEndpoint {
  url: string;
  token: string;
}

export interface BrokeredRequest {
  provider: string;
  slot?: string;
  url: string;
  headers?: Record<string, string>;
}

export interface BrokeredResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export function egressFromEnv(env: NodeJS.ProcessEnv = process.env): EgressEndpoint | null {
  const url = env["VAULT_EGRESS_URL"];
  const token = env["VAULT_EGRESS_TOKEN"];
  if (url === undefined || url.trim() === "" || token === undefined || token.trim() === "") {
    return null;
  }
  return { url: url.trim(), token: token.trim() };
}

/**
 * Sends one GET-semantics request through the broker. Upstream non-2xx comes
 * back as data ({status, body}); a thrown error always carries a `.code`
 * (broker denial codes, or "egress_unreachable" / "egress_error").
 */
export async function brokeredGet(
  egress: EgressEndpoint,
  request: BrokeredRequest,
): Promise<BrokeredResponse> {
  let response: Response;
  try {
    response = await fetch(`${egress.url}/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${egress.token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        provider: request.provider,
        slot: request.slot ?? "default",
        url: request.url,
        headers: request.headers ?? {},
      }),
    });
  } catch (error) {
    throw withCode(
      new Error(`egress broker unreachable at ${egress.url}`, { cause: error }),
      "egress_unreachable",
    );
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "egress_error";
    const message =
      typeof error?.message === "string"
        ? error.message
        : `egress broker rejected the request (HTTP ${String(response.status)})`;
    throw withCode(new Error(message), code);
  }
  const ok = payload as {
    status?: unknown;
    contentType?: unknown;
    body?: unknown;
  } | null;
  if (ok === null || typeof ok.status !== "number" || typeof ok.body !== "string") {
    throw withCode(new Error("egress broker returned a malformed response"), "egress_error");
  }
  return {
    status: ok.status,
    contentType: typeof ok.contentType === "string" ? ok.contentType : null,
    body: ok.body,
  };
}

export interface BrokeredTokenRequest {
  provider: string;
  slot?: string;
}

export interface BrokeredToken {
  accessToken: string;
  expiresAt: string;
}

/**
 * Exchanges a broker-held refresh token for a short-lived access token via
 * POST /token. The durable credential never enters this process. Thrown
 * errors always carry a `.code` (broker codes like grant_missing /
 * not_connected / token_revoked / oauth_not_configured, or
 * "egress_unreachable" / "egress_error").
 */
export async function brokeredToken(
  egress: EgressEndpoint,
  request: BrokeredTokenRequest,
): Promise<BrokeredToken> {
  let response: Response;
  try {
    response = await fetch(`${egress.url}/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${egress.token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ provider: request.provider, slot: request.slot ?? "default" }),
    });
  } catch (error) {
    throw withCode(
      new Error(`egress broker unreachable at ${egress.url}`, { cause: error }),
      "egress_unreachable",
    );
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "egress_error";
    const message =
      typeof error?.message === "string"
        ? error.message
        : `egress broker rejected the token exchange (HTTP ${String(response.status)})`;
    throw withCode(new Error(message), code);
  }
  const ok = payload as { access_token?: unknown; expires_at?: unknown } | null;
  if (ok === null || typeof ok.access_token !== "string" || typeof ok.expires_at !== "string") {
    throw withCode(new Error("egress broker returned a malformed token response"), "egress_error");
  }
  return { accessToken: ok.access_token, expiresAt: ok.expires_at };
}

export interface BrokeredProfileRequest {
  fields: readonly string[];
}

/**
 * Grant-gated profile read through the broker (POST /profile). Returns only
 * fields that are granted AND set. Coded errors: grant_missing (message lists
 * the denied fields), egress_denied, egress_unreachable, egress_error.
 */
export async function brokeredProfile(
  egress: EgressEndpoint,
  request: BrokeredProfileRequest,
): Promise<Record<string, string>> {
  const payload = await postJson(egress, "/profile", { fields: [...request.fields] });
  const fields = (payload as { fields?: unknown }).fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw withCode(new Error("egress broker returned a malformed profile response"), "egress_error");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

export interface BrokeredCommonsRequest {
  dataset: string;
  key?: string;
}

/**
 * Public-read commons dataset through the broker (POST /commons). Coded
 * errors: egress_denied (undeclared dataset), commons_not_configured,
 * commons_not_found, commons_key_not_found, commons_error, egress_unreachable.
 */
export async function brokeredCommons(
  egress: EgressEndpoint,
  request: BrokeredCommonsRequest,
): Promise<unknown> {
  const payload = await postJson(egress, "/commons", {
    dataset: request.dataset,
    ...(request.key === undefined ? {} : { key: request.key }),
  });
  return (payload as { data?: unknown }).data;
}

async function postJson(
  egress: EgressEndpoint,
  path: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${egress.url}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${egress.token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw withCode(
      new Error(`egress broker unreachable at ${egress.url}`, { cause: error }),
      "egress_unreachable",
    );
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "egress_error";
    const message =
      typeof error?.message === "string"
        ? error.message
        : `egress broker rejected the request (HTTP ${String(response.status)})`;
    throw withCode(new Error(message), code);
  }
  if (payload === null || typeof payload !== "object") {
    throw withCode(new Error("egress broker returned a malformed response"), "egress_error");
  }
  return payload;
}

function withCode(error: Error, code: string): Error {
  (error as Error & { code: string }).code = code;
  return error;
}
