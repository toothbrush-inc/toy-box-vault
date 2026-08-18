import { mkdirSync } from "node:fs";

import { FileConnectionStore, connectionsPath } from "./connections.js";
import { GrantError, VaultError } from "./errors.js";
import { FileSecretStore, secretsPath } from "./file-secrets.js";
import { FileGrantStore, grantsPath } from "./grants.js";
import { resolveVaultHome } from "./home.js";
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
  type SecretStore,
} from "./types.js";

export type SecretBackend = "keychain" | "file";

export interface OpenVaultOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  connections?: ConnectionStore;
  grants?: GrantStore;
  grantMode?: GrantMode;
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
    readonly grantMode: GrantMode,
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
    if (input.action === undefined || record.actions.length === 0) {
      return true;
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
  const grantMode = options.grantMode ?? grantModeFrom(env);
  return new Vault(home, secrets, connections, grants, grantMode, options.now);
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
