import {
  connectionId,
  type CapabilityManifest,
  type ManifestConnectionNeed,
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
    return parsed;
  });
  return { id: record.id.trim().toLowerCase(), connections };
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
