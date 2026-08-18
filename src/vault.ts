import { mkdirSync } from "node:fs";

import { FileConnectionStore, connectionsPath } from "./connections.js";
import { VaultError } from "./errors.js";
import { FileSecretStore, secretsPath } from "./file-secrets.js";
import { resolveVaultHome } from "./home.js";
import { KeychainSecretStore } from "./keychain.js";
import {
  connectionId,
  maskSecret,
  type ConnectionRecord,
  type ConnectionStore,
  type ConnectionView,
  type PutSecretInput,
  type SecretStore,
} from "./types.js";

export type SecretBackend = "keychain" | "file";

export interface OpenVaultOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  connections?: ConnectionStore;
  backend?: SecretBackend;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

export class Vault {
  constructor(
    readonly home: string,
    private readonly secrets: SecretStore,
    private readonly connections: ConnectionStore,
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
    return secretDeleted || recordDeleted;
  }
}

export function openVault(options: OpenVaultOptions = {}): Vault {
  const env = options.env ?? process.env;
  const home = resolveVaultHome(options.home, env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const secrets = options.secrets ?? createSecretStore(home, options, env);
  const connections = options.connections ?? new FileConnectionStore(connectionsPath(home));
  return new Vault(home, secrets, connections, options.now);
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
