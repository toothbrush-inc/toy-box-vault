import {
  connectionId,
  type CapabilityManifest,
  type ManifestConnectionNeed,
  type ManifestEgressSpec,
  type PutGrantInput,
} from "./types.js";

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capability manifest must be an object");
  }
  const record = value as { id?: unknown; connections?: unknown };
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new Error("capability manifest id is required");
  }
  if (!Array.isArray(record.connections)) {
    throw new Error("capability manifest connections must be an array");
  }
  const connections: ManifestConnectionNeed[] = record.connections.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`capability manifest connections[${String(index)}] must be an object`);
    }
    const need = entry as {
      provider?: unknown;
      slot?: unknown;
      optional?: unknown;
      actions?: unknown;
      egress?: unknown;
    };
    if (typeof need.provider !== "string" || need.provider.trim() === "") {
      throw new Error(`capability manifest connections[${String(index)}].provider is required`);
    }
    if (typeof need.slot !== "string" || need.slot.trim() === "") {
      throw new Error(`capability manifest connections[${String(index)}].slot is required`);
    }
    if (typeof need.optional !== "boolean") {
      throw new Error(`capability manifest connections[${String(index)}].optional must be a boolean`);
    }
    const parsed: ManifestConnectionNeed = {
      provider: need.provider.trim().toLowerCase(),
      slot: need.slot.trim().toLowerCase(),
      optional: need.optional,
    };
    if (need.actions !== undefined) {
      if (!Array.isArray(need.actions) || need.actions.some((action) => typeof action !== "string")) {
        throw new Error(`capability manifest connections[${String(index)}].actions must be strings`);
      }
      parsed.actions = need.actions.map((action) => action.trim()).filter(Boolean);
    }
    if (need.egress !== undefined) {
      parsed.egress = parseEgress(need.egress, index);
    }
    return parsed;
  });
  return { id: record.id.trim().toLowerCase(), connections };
}

function parseEgress(value: unknown, index: number): ManifestEgressSpec {
  const label = `capability manifest connections[${String(index)}].egress`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const spec = value as { hosts?: unknown; attach?: unknown; hostRewrite?: unknown };
  if (!Array.isArray(spec.hosts) || spec.hosts.length === 0) {
    throw new Error(`${label}.hosts must be a non-empty array`);
  }
  const hosts = spec.hosts.map((host) => requireHostname(host, `${label}.hosts`));
  if (typeof spec.attach !== "object" || spec.attach === null || Array.isArray(spec.attach)) {
    throw new Error(`${label}.attach must be an object`);
  }
  const attach = spec.attach as { kind?: unknown; name?: unknown };
  if (attach.kind !== "header" && attach.kind !== "query") {
    throw new Error(`${label}.attach.kind must be "header" or "query"`);
  }
  if (typeof attach.name !== "string" || attach.name.trim() === "") {
    throw new Error(`${label}.attach.name is required`);
  }
  const parsed: ManifestEgressSpec = {
    hosts,
    attach: { kind: attach.kind, name: attach.name.trim() },
  };
  if (spec.hostRewrite !== undefined) {
    if (
      typeof spec.hostRewrite !== "object" ||
      spec.hostRewrite === null ||
      Array.isArray(spec.hostRewrite)
    ) {
      throw new Error(`${label}.hostRewrite must be an object`);
    }
    const rewrite: Record<string, string> = {};
    for (const [from, to] of Object.entries(spec.hostRewrite)) {
      rewrite[requireHostname(from, `${label}.hostRewrite`)] = requireHostname(
        to,
        `${label}.hostRewrite`,
      );
    }
    parsed.hostRewrite = rewrite;
  }
  return parsed;
}

function requireHostname(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} entries must be non-empty strings`);
  }
  const host = value.trim().toLowerCase();
  if (/[/:\s]/u.test(host)) {
    throw new Error(`${label} entries must be bare hostnames (no scheme, port, or path)`);
  }
  return host;
}

export function grantFromManifest(
  manifest: CapabilityManifest,
  provider: string,
  slot: string,
): PutGrantInput {
  const id = connectionId(provider, slot);
  const need = manifest.connections.find(
    (connection) => connectionId(connection.provider, connection.slot) === id,
  );
  if (need === undefined) {
    throw new Error(`capability ${manifest.id} does not declare connection ${id}`);
  }
  const grant: PutGrantInput = { capability: manifest.id, connectionId: id };
  if (need.actions !== undefined) {
    grant.actions = [...need.actions];
  }
  return grant;
}
