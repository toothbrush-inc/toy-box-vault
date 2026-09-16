import {
  connectionId,
  type CapabilityManifest,
  type ManifestConnectionNeed,
  type ManifestData,
  type ManifestEgressSpec,
  type ManifestStore,
  type ManifestTools,
  type PutGrantInput,
  STORE_ACCENTS,
  type StoreAccent,
} from "./types.js";

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capability manifest must be an object");
  }
  const record = value as {
    id?: unknown;
    connections?: unknown;
    data?: unknown;
    tools?: unknown;
    store?: unknown;
  };
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
  const manifest: CapabilityManifest = { id: record.id.trim().toLowerCase(), connections };
  if (record.data !== undefined) {
    manifest.data = parseData(record.data);
  }
  if (record.tools !== undefined) {
    manifest.tools = parseTools(record.tools);
  }
  if (record.store !== undefined) {
    manifest.store = parseStore(record.store);
  }
  return manifest;
}

const STORE_LIMITS = { name: 60, tagline: 120, description: 600, highlight: 120, badge: 20 } as const;
const STORE_MAX_HIGHLIGHTS = 4;

function storeText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined) {
    if (required) {
      throw new Error(`capability manifest store.${field} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`capability manifest store.${field} must be a string`);
  }
  const text = value.trim();
  if (text === "") {
    if (required) {
      throw new Error(`capability manifest store.${field} is required`);
    }
    return undefined;
  }
  if (text.length > max) {
    throw new Error(`capability manifest store.${field} must be at most ${String(max)} characters`);
  }
  return text;
}

function parseStore(value: unknown): ManifestStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capability manifest store must be an object");
  }
  const record = value as {
    name?: unknown;
    tagline?: unknown;
    description?: unknown;
    highlights?: unknown;
    badge?: unknown;
    accent?: unknown;
    web?: unknown;
    repo?: unknown;
  };
  const store: ManifestStore = { name: storeText(record.name, "name", STORE_LIMITS.name, true) as string };
  const tagline = storeText(record.tagline, "tagline", STORE_LIMITS.tagline);
  if (tagline !== undefined) {
    store.tagline = tagline;
  }
  const description = storeText(record.description, "description", STORE_LIMITS.description);
  if (description !== undefined) {
    store.description = description;
  }
  if (record.highlights !== undefined) {
    if (!Array.isArray(record.highlights)) {
      throw new Error("capability manifest store.highlights must be an array");
    }
    if (record.highlights.length > STORE_MAX_HIGHLIGHTS) {
      throw new Error(`capability manifest store.highlights must have at most ${String(STORE_MAX_HIGHLIGHTS)} entries`);
    }
    store.highlights = record.highlights.map(
      (line, index) => storeText(line, `highlights[${String(index)}]`, STORE_LIMITS.highlight, true) as string,
    );
  }
  const badge = storeText(record.badge, "badge", STORE_LIMITS.badge);
  if (badge !== undefined) {
    store.badge = badge;
  }
  if (record.accent !== undefined) {
    if (typeof record.accent !== "string" || !(STORE_ACCENTS as readonly string[]).includes(record.accent)) {
      throw new Error(`capability manifest store.accent must be one of ${STORE_ACCENTS.join(", ")}`);
    }
    store.accent = record.accent as StoreAccent;
  }
  if (record.web !== undefined) {
    if (typeof record.web !== "object" || record.web === null || Array.isArray(record.web)) {
      throw new Error("capability manifest store.web must be an object");
    }
    const path = (record.web as { path?: unknown }).path;
    if (typeof path !== "string" || !/^\/[A-Za-z0-9/_-]*$/u.test(path)) {
      throw new Error("capability manifest store.web.path must be an absolute path");
    }
    store.web = { path };
  }
  if (record.repo !== undefined) {
    if (typeof record.repo !== "string" || !/^https?:\/\/\S+$/u.test(record.repo.trim())) {
      throw new Error("capability manifest store.repo must be an http(s) URL");
    }
    store.repo = record.repo.trim();
  }
  return store;
}

function parseTools(value: unknown): ManifestTools {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capability manifest tools must be an object");
  }
  const record = value as { query?: unknown };
  const tools: ManifestTools = {};
  if (record.query !== undefined) {
    if (!Array.isArray(record.query) || record.query.some((tool) => typeof tool !== "string")) {
      throw new Error("capability manifest tools.query must be an array of tool names");
    }
    const names = record.query.map((tool) => tool.trim().toLowerCase()).filter(Boolean);
    for (const name of names) {
      if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
        throw new Error(`capability manifest tools.query entry '${name}' must be a tool name`);
      }
    }
    tools.query = [...new Set(names)];
  }
  return tools;
}

function parseData(value: unknown): ManifestData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capability manifest data must be an object");
  }
  const record = value as { private?: unknown; commons?: unknown };
  const data: ManifestData = {};
  if (record.private !== undefined) {
    if (!Array.isArray(record.private)) {
      throw new Error("capability manifest data.private must be an array");
    }
    data.private = record.private.map((entry, index) => {
      const label = `data.private[${String(index)}]`;
      const parsed = parseDataEntry(entry, "name", label);
      const extras = entry as { env?: unknown; file?: unknown };
      const out: import("./types.js").ManifestPrivateData = parsed;
      if (extras.env !== undefined) {
        if (typeof extras.env !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(extras.env.trim())) {
          throw new Error(`capability manifest ${label}.env must be an UPPER_SNAKE_CASE env var name`);
        }
        out.env = extras.env.trim();
      }
      if (extras.file !== undefined) {
        if (
          typeof extras.file !== "string" ||
          extras.file.trim() === "" ||
          /[/\\]/u.test(extras.file)
        ) {
          throw new Error(`capability manifest ${label}.file must be a bare filename`);
        }
        out.file = extras.file.trim();
      }
      return out;
    });
  }
  if (record.commons !== undefined) {
    if (!Array.isArray(record.commons)) {
      throw new Error("capability manifest data.commons must be an array");
    }
    data.commons = record.commons.map((entry, index) => {
      const parsed = parseDataEntry(entry, "dataset", `data.commons[${String(index)}]`);
      return { dataset: parsed.name, ...(parsed.description === undefined ? {} : { description: parsed.description }) };
    });
  }
  return data;
}

function parseDataEntry(
  entry: unknown,
  keyField: "name" | "dataset",
  label: string,
): { name: string; description?: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`capability manifest ${label} must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const raw = record[keyField];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`capability manifest ${label}.${keyField} is required`);
  }
  const name = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/u.test(name)) {
    throw new Error(`capability manifest ${label}.${keyField} must be a lowercase identifier`);
  }
  const out: { name: string; description?: string } = { name };
  if (record["description"] !== undefined) {
    if (typeof record["description"] !== "string") {
      throw new Error(`capability manifest ${label}.description must be a string`);
    }
    const description = record["description"].trim().slice(0, 200);
    if (description !== "") {
      out.description = description;
    }
  }
  return out;
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
