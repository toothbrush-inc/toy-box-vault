import { execFile } from "node:child_process";

import { KeychainError } from "./errors.js";
import { DEFAULT_KEYCHAIN_SERVICE } from "./home.js";
import type { SecretStore } from "./types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface KeychainSecretStoreOptions {
  service?: string;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
}

export class KeychainSecretStore implements SecretStore {
  private readonly service: string;
  private readonly run: CommandRunner;

  constructor(options: KeychainSecretStoreOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin") {
      throw new KeychainError("macOS Keychain storage is only available on macOS");
    }
    this.service = options.service ?? DEFAULT_KEYCHAIN_SERVICE;
    this.run = options.run ?? runCommand;
  }

  async get(id: string): Promise<string | null> {
    try {
      const result = await this.run("security", [
        "find-generic-password",
        "-a",
        id,
        "-s",
        this.service,
        "-w",
      ]);
      const token = result.stdout.trim();
      return token === "" ? null : token;
    } catch (error) {
      if (isMissingItem(error)) {
        return null;
      }
      throw keychainFailure("read");
    }
  }

  async set(id: string, secret: string): Promise<void> {
    if (secret.trim() === "") {
      throw new KeychainError("Refusing to store an empty secret");
    }

    try {
      await this.run("security", [
        "add-generic-password",
        "-U",
        "-a",
        id,
        "-s",
        this.service,
        "-w",
        secret,
      ]);
    } catch {
      throw keychainFailure("write");
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.run("security", ["delete-generic-password", "-a", id, "-s", this.service]);
      return true;
    } catch (error) {
      if (isMissingItem(error)) {
        return false;
      }
      throw keychainFailure("delete");
    }
  }
}

function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(
          Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          }),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isMissingItem(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; stderr?: unknown };
  return (
    candidate.code === 44 ||
    (typeof candidate.stderr === "string" &&
      candidate.stderr.includes("The specified item could not be found"))
  );
}

function keychainFailure(operation: string): KeychainError {
  return new KeychainError(`Unable to ${operation} secret in macOS Keychain`);
}
