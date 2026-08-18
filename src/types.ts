export type ConnectionKind = "oauth" | "apikey";
export type ConnectionStatus = "ok" | "broken" | "missing";
export type SecretOrigin = "vault" | "none";

export interface ConnectionRecord {
  id: string;
  provider: string;
  slot: string;
  kind: ConnectionKind;
  status: ConnectionStatus;
  scopes: string[];
  secretRef: string;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionView {
  id: string;
  provider: string;
  slot: string;
  kind: ConnectionKind;
  status: ConnectionStatus;
  set: boolean;
  origin: SecretOrigin;
  masked: string;
  scopes: string[];
  validatedAt: string | null;
}

export interface PutSecretInput {
  provider: string;
  slot: string;
  kind: ConnectionKind;
  secret: string;
  scopes?: readonly string[];
  status?: Exclude<ConnectionStatus, "missing">;
  now?: Date;
}

export interface SecretStore {
  get(id: string): Promise<string | null>;
  set(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface ConnectionStore {
  get(id: string): ConnectionRecord | null;
  list(): ConnectionRecord[];
  put(record: ConnectionRecord): void;
  delete(id: string): boolean;
}

export type GrantMode = "auto" | "explicit";

export interface GrantRecord {
  id: string;
  capability: string;
  connectionId: string;
  actions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PutGrantInput {
  capability: string;
  connectionId: string;
  actions?: readonly string[];
  now?: Date;
}

export interface CheckGrantInput {
  capability: string;
  connectionId: string;
  action?: string;
}

export interface GrantStore {
  get(id: string): GrantRecord | null;
  list(capability?: string): GrantRecord[];
  put(record: GrantRecord): void;
  delete(id: string): boolean;
  deleteForConnection(connectionId: string): number;
}

export interface ManifestConnectionNeed {
  provider: string;
  slot: string;
  optional: boolean;
  actions?: string[];
}

export interface CapabilityManifest {
  id: string;
  connections: ManifestConnectionNeed[];
}

export function connectionId(provider: string, slot: string): string {
  const normalizedProvider = requireToken(provider, "provider");
  const normalizedSlot = requireToken(slot, "slot");
  return `${normalizedProvider}:${normalizedSlot}`;
}

export function grantId(capability: string, connectionIdValue: string): string {
  const normalizedCapability = requireToken(capability, "capability");
  const trimmed = connectionIdValue.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error("connectionId is required");
  }
  return `${normalizedCapability}:${trimmed}`;
}

export function maskSecret(value: string): string {
  if (value.length === 0) {
    return "";
  }
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function requireToken(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} is required`);
  }
  if (!/^[a-z][a-z0-9_-]*$/iu.test(trimmed)) {
    throw new Error(`${field} must be a lowercase identifier`);
  }
  return trimmed.toLowerCase();
}
