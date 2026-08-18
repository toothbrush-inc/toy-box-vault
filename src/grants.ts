import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "./fs.js";
import type { GrantRecord, GrantStore } from "./types.js";

interface GrantsFile {
  grants: Record<string, GrantRecord>;
}

export class FileGrantStore implements GrantStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  get(id: string): GrantRecord | null {
    return this.read().grants[id] ?? null;
  }

  list(capability?: string): GrantRecord[] {
    const rows = Object.values(this.read().grants);
    const filtered =
      capability === undefined ? rows : rows.filter((row) => row.capability === capability);
    return filtered.sort((left, right) => left.id.localeCompare(right.id));
  }

  put(record: GrantRecord): void {
    const file = this.read();
    file.grants[record.id] = record;
    this.write(file);
  }

  delete(id: string): boolean {
    const file = this.read();
    if (file.grants[id] === undefined) {
      return false;
    }
    const grants = Object.fromEntries(
      Object.entries(file.grants).filter(([key]) => key !== id),
    );
    this.write({ grants });
    return true;
  }

  deleteForConnection(connectionId: string): number {
    const file = this.read();
    const keep = Object.entries(file.grants).filter(([, row]) => row.connectionId !== connectionId);
    const removed = Object.keys(file.grants).length - keep.length;
    if (removed > 0) {
      this.write({ grants: Object.fromEntries(keep) });
    }
    return removed;
  }

  private read(): GrantsFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { grants: {} };
      }
      const record = parsed as { grants?: unknown };
      if (
        typeof record.grants !== "object" ||
        record.grants === null ||
        Array.isArray(record.grants)
      ) {
        return { grants: {} };
      }
      return { grants: record.grants as Record<string, GrantRecord> };
    } catch (error) {
      if (isMissingFile(error)) {
        return { grants: {} };
      }
      throw error;
    }
  }

  private write(file: GrantsFile): void {
    atomicWriteFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

export function grantsPath(home: string): string {
  return join(home, "grants.json");
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
