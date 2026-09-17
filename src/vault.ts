import { mkdirSync } from "node:fs";

import { FileConnectionStore, connectionsPath } from "./connections.js";
import { EgressRequiredError, GrantError, ProfileBoundsError, VaultError } from "./errors.js";
import { FileSecretStore, secretsPath } from "./file-secrets.js";
import { FileGrantStore, grantsPath } from "./grants.js";
import { resolveVaultHome } from "./home.js";
import { CAPABILITY_PROVIDER } from "./peer.js";
import {
  FileProfileStore,
  PROFILE_CONNECTION_ID,
  PROFILE_PROVIDER,
  PROFILE_MAX_FIELD_LENGTH,
  PROFILE_MAX_FIELDS,
  PROFILE_MAX_FILE_BYTES,
  PROFILE_MAX_VALUE_LENGTH,
  profilePath,
  type ProfileStore,
} from "./profile.js";
import { KeychainSecretStore } from "./keychain.js";
import {
  connectionId,
  grantId,
  maskSecret,
  type CheckGrantInput,
  type ConnectionRecord,
  type ConnectionStore,
  type ConnectionView,
  type GrantMode,
  type GrantRecord,
  type GrantStore,
  type PutGrantInput,
  type PutSecretInput,
  type SecretsAccess,
  type SecretStore,
} from "./types.js";

export type SecretBackend = "keychain" | "file";

export interface OpenVaultOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  connections?: ConnectionStore;
  grants?: GrantStore;
  profile?: ProfileStore;
  grantMode?: GrantMode;
  secretsAccess?: SecretsAccess;
  backend?: SecretBackend;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

export class Vault {
  constructor(
    readonly home: string,
    private readonly secrets: SecretStore,
    private readonly connections: ConnectionStore,
    private readonly grants: GrantStore,
    private readonly profile: ProfileStore,
    readonly grantMode: GrantMode,
    readonly secretsAccess: SecretsAccess = "direct",
    private readonly now: () => Date = () => new Date(),
  ) {}

  id(provider: string, slot: string): string {
    return connectionId(provider, slot);
  }

  async status(id: string): Promise<ConnectionView> {
    const record = this.connections.get(id);
    const secret = await this.secrets.get(record?.secretRef ?? id);
    return viewFrom(id, record, secret);
  }

  async list(): Promise<ConnectionView[]> {
    const records = this.connections.list();
    const views: ConnectionView[] = [];
    for (const record of records) {
      views.push(await this.status(record.id));
    }
    return views;
  }

  async getSecret(id: string): Promise<string | null> {
    const record = this.connections.get(id);
    return this.secrets.get(record?.secretRef ?? id);
  }

  async getSecretFor(capability: string, id: string, action?: string): Promise<string | null> {
    if (this.secretsAccess === "broker") {
      throw new EgressRequiredError(
        "fetch-path secret reads are broker-only in this process; route the request through brokered egress",
      );
    }
    const check: CheckGrantInput = { capability, connectionId: id };
    if (action !== undefined) {
      check.action = action;
    }
    if (!this.checkGrant(check)) {
      throw new GrantError(`capability ${capability} is not granted ${id}`);
    }
    return this.getSecret(id);
  }

  checkGrant(input: CheckGrantInput): boolean {
    if (this.grantMode === "auto") {
      return true;
    }
    const record = this.grants.get(grantId(input.capability, input.connectionId));
    if (record === null) {
      return false;
    }
    if (input.action === undefined) {
      return true;
    }
    if (record.actions.length === 0) {
      // Credential connections: no actions means every action. Profile and
      // peer connections enumerate what they expose, so an empty list grants
      // nothing (CAPABILITY.md §9–10) rather than every field or tool.
      return !enumeratesActions(record.connectionId);
    }
    return record.actions.includes(input.action);
  }

  putGrant(input: PutGrantInput): GrantRecord {
    const timestamp = iso(input.now ?? this.now());
    const id = grantId(input.capability, input.connectionId);
    const existing = this.grants.get(id);
    const record: GrantRecord = {
      id,
      capability: input.capability.trim().toLowerCase(),
      connectionId: input.connectionId.trim().toLowerCase(),
      actions: [...(input.actions ?? [])],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.grants.put(record);
    return record;
  }

  listGrants(capability?: string): GrantRecord[] {
    return this.grants.list(capability);
  }

  revokeGrant(capability: string, connectionIdValue: string): boolean {
    return this.grants.delete(grantId(capability, connectionIdValue));
  }

  async putSecret(input: PutSecretInput): Promise<ConnectionRecord> {
    if (input.secret.trim() === "") {
      throw new VaultError("Refusing to store an empty secret");
    }
    const id = connectionId(input.provider, input.slot);
    const timestamp = iso(input.now ?? this.now());
    const existing = this.connections.get(id);
    const record: ConnectionRecord = {
      id,
      provider: input.provider.trim().toLowerCase(),
      slot: input.slot.trim().toLowerCase(),
      kind: input.kind,
      status: input.status ?? "ok",
      scopes: [...(input.scopes ?? [])],
      secretRef: existing?.secretRef ?? id,
      validatedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.secrets.set(record.secretRef, input.secret);
    this.connections.put(record);
    return record;
  }

  /**
   * Grant-gated per-field profile read for a capability's fetch path.
   * Returns only requested fields that are set; absence means not-configured
   * (the capability applies its own defaults). Profile data always survives
   * grant revocation — access dies, data stays.
   */
  async getProfileFor(
    capability: string,
    fields: readonly string[],
  ): Promise<Record<string, string>> {
    if (this.secretsAccess === "broker") {
      throw new EgressRequiredError(
        "profile reads are broker-only in this process; route the request through brokered egress",
      );
    }
    for (const field of fields) {
      const check: CheckGrantInput = {
        capability,
        connectionId: PROFILE_CONNECTION_ID,
        action: field,
      };
      if (!this.checkGrant(check)) {
        throw new GrantError(
          `capability ${capability} is not granted profile field '${field}' (grant ${PROFILE_CONNECTION_ID} with that action)`,
        );
      }
    }
    const stored = this.profile.read();
    const out: Record<string, string> = {};
    for (const field of fields) {
      const value = stored[field];
      if (value !== undefined) {
        out[field] = value;
      }
    }
    return Promise.resolve(out);
  }

  /** Owner-side merge upsert; ungated. Enforces the not-a-data-lake bounds. */
  putProfile(fields: Record<string, string>): Record<string, string> {
    const merged = { ...this.profile.read() };
    for (const [rawField, rawValue] of Object.entries(fields)) {
      const field = requireProfileField(rawField);
      const value = rawValue.trim();
      if (value === "") {
        throw new VaultError(`profile field '${field}' must not be empty (delete it instead)`);
      }
      if (value.length > PROFILE_MAX_VALUE_LENGTH) {
        throw new ProfileBoundsError(
          `profile value for '${field}' exceeds ${String(PROFILE_MAX_VALUE_LENGTH)} characters`,
        );
      }
      merged[field] = value;
    }
    if (Object.keys(merged).length > PROFILE_MAX_FIELDS) {
      throw new ProfileBoundsError(
        `profile is limited to ${String(PROFILE_MAX_FIELDS)} fields; it must not grow into a data lake`,
      );
    }
    if (JSON.stringify({ fields: merged }).length > PROFILE_MAX_FILE_BYTES) {
      throw new ProfileBoundsError(
        `profile is limited to ${String(PROFILE_MAX_FILE_BYTES)} bytes; it must not grow into a data lake`,
      );
    }
    this.profile.write(merged);
    return merged;
  }

  /** Owner-side field removal; ungated. */
  deleteProfileField(field: string): boolean {
    const stored = this.profile.read();
    const normalized = requireProfileField(field);
    if (stored[normalized] === undefined) {
      return false;
    }
    const rest = Object.fromEntries(
      Object.entries(stored).filter(([key]) => key !== normalized),
    );
    this.profile.write(rest);
    return true;
  }

  /** Owner-side full read for status/CLI display. Profile values are not secrets. */
  getProfile(): Record<string, string> {
    return this.profile.read();
  }

  async revoke(id: string): Promise<boolean> {
    const record = this.connections.get(id);
    const secretDeleted = await this.secrets.delete(record?.secretRef ?? id);
    const recordDeleted = this.connections.delete(id);
    this.grants.deleteForConnection(id);
    return secretDeleted || recordDeleted;
  }
}

export function openVault(options: OpenVaultOptions = {}): Vault {
  const env = options.env ?? process.env;
  const home = resolveVaultHome(options.home, env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const secrets = options.secrets ?? createSecretStore(home, options, env);
  const connections = options.connections ?? new FileConnectionStore(connectionsPath(home));
  const grants = options.grants ?? new FileGrantStore(grantsPath(home));
  const profile = options.profile ?? new FileProfileStore(profilePath(home));
  const grantMode = options.grantMode ?? grantModeFrom(env);
  const secretsAccess = options.secretsAccess ?? secretsAccessFrom(env);
  return new Vault(home, secrets, connections, grants, profile, grantMode, secretsAccess, options.now);
}

/** Connections whose `actions` are the whole grant, with no wildcard. */
function enumeratesActions(connectionIdValue: string): boolean {
  const provider = connectionIdValue.split(":", 1)[0];
  return provider === PROFILE_PROVIDER || provider === CAPABILITY_PROVIDER;
}

function requireProfileField(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed.length > PROFILE_MAX_FIELD_LENGTH || !/^[a-z][a-z0-9_-]*$/u.test(trimmed)) {
    throw new VaultError(
      `'${value}' is not a valid profile field name (lowercase token, max ${String(PROFILE_MAX_FIELD_LENGTH)} chars)`,
    );
  }
  return trimmed;
}

function createSecretStore(
  home: string,
  options: OpenVaultOptions,
  env: NodeJS.ProcessEnv,
): SecretStore {
  const backend = options.backend ?? secretBackendFrom(env, options.platform ?? process.platform);
  if (backend === "file") {
    return new FileSecretStore(secretsPath(home));
  }
  const keychainOptions: { platform?: NodeJS.Platform } = {};
  if (options.platform !== undefined) {
    keychainOptions.platform = options.platform;
  }
  return new KeychainSecretStore(keychainOptions);
}

function secretsAccessFrom(env: NodeJS.ProcessEnv): SecretsAccess {
  return env["VAULT_SECRETS_ACCESS"] === "broker" ? "broker" : "direct";
}

function grantModeFrom(env: NodeJS.ProcessEnv): GrantMode {
  const configured = env["VAULT_GRANT_MODE"];
  if (configured === "explicit" || configured === "auto") {
    return configured;
  }
  return "auto";
}

function secretBackendFrom(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): SecretBackend {
  const configured = env["VAULT_SECRETS_BACKEND"];
  if (configured === "file" || configured === "keychain") {
    return configured;
  }
  return platform === "darwin" ? "keychain" : "file";
}

function viewFrom(
  id: string,
  record: ConnectionRecord | null,
  secret: string | null,
): ConnectionView {
  const set = secret !== null;
  const [provider, slot] = splitId(id, record);
  return {
    id,
    provider,
    slot,
    kind: record?.kind ?? "oauth",
    status: record?.status ?? (set ? "ok" : "missing"),
    set,
    origin: set ? "vault" : "none",
    masked: secret === null ? "" : maskSecret(secret),
    scopes: record?.scopes ?? [],
    validatedAt: record?.validatedAt ?? null,
  };
}

function splitId(id: string, record: ConnectionRecord | null): readonly [string, string] {
  if (record !== null) {
    return [record.provider, record.slot];
  }
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) {
    return [id, "default"];
  }
  return [id.slice(0, separator), id.slice(separator + 1)];
}

function iso(value: Date): string {
  return value.toISOString();
}
