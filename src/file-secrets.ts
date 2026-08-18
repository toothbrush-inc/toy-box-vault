import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VaultError } from "./errors.js";
import { atomicWriteFile } from "./fs.js";
import type { SecretStore } from "./types.js";

export class FileSecretStore implements SecretStore {
  constructor(private readonly path: string) {}

  get(id: string): Promise<string | null> {
    const secret = this.read()[id];
    return Promise.resolve(secret === undefined || secret === "" ? null : secret);
  }

  set(id: string, secret: string): Promise<void> {
    if (secret.trim() === "") {
      return Promise.reject(new VaultError("Refusing to store an empty secret"));
    }
    const secrets = this.read();
    secrets[id] = secret;
    this.write(secrets);
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const secrets = this.read();
    if (secrets[id] === undefined) {
      return Promise.resolve(false);
    }
    const rest = Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== id));
    this.write(rest);
    return Promise.resolve(true);
  }

  private read(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, string>;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return {};
      }
      throw error;
    }
  }

  private write(secrets: Record<string, string>): void {
    atomicWriteFile(this.path, `${JSON.stringify(secrets)}\n`);
  }
}

export function secretsPath(home: string): string {
  return join(home, "secrets.json");
}
