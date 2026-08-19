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

function withCode(error: Error, code: string): Error {
  (error as Error & { code: string }).code = code;
  return error;
}
