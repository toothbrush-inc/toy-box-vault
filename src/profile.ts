// The user profile: a deliberately tiny store of stable user facts many
// capabilities need (units, timezone, home location, ...). Grant-gated per
// FIELD via the ordinary grants machinery: capabilities declare a
// `profile:default` connection whose `actions` are the field names they may
// read. Values are not secrets (plain display is fine); they must simply
// never appear in audit output. Hard bounds keep this from growing into a
// data lake.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "./fs.js";

export const PROFILE_PROVIDER = "profile";
export const PROFILE_CONNECTION_ID = "profile:default";
export const PROFILE_MAX_FIELDS = 32;
export const PROFILE_MAX_FIELD_LENGTH = 64;
export const PROFILE_MAX_VALUE_LENGTH = 256;
export const PROFILE_MAX_FILE_BYTES = 16 * 1024;

export interface ProfileStore {
  read(): Record<string, string>;
  write(fields: Record<string, string>): void;
}

interface ProfileFile {
  fields: Record<string, string>;
}

export function profilePath(home: string): string {
  return join(home, "profile.json");
}

export class FileProfileStore implements ProfileStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  read(): Record<string, string> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as ProfileFile;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.fields !== "object") {
        return {};
      }
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.fields ?? {})) {
        if (typeof value === "string") {
          fields[key] = value;
        }
      }
      return fields;
    } catch {
      return {};
    }
  }

  write(fields: Record<string, string>): void {
    const file: ProfileFile = { fields };
    atomicWriteFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
