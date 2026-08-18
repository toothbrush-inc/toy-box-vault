import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "./fs.js";
import type { ConnectionRecord, ConnectionStore } from "./types.js";

interface ConnectionsFile {
  connections: Record<string, ConnectionRecord>;
}

export class FileConnectionStore implements ConnectionStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  get(id: string): ConnectionRecord | null {
    return this.read().connections[id] ?? null;
  }

  list(): ConnectionRecord[] {
    return Object.values(this.read().connections).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  put(record: ConnectionRecord): void {
    const file = this.read();
    file.connections[record.id] = record;
    this.write(file);
  }

  delete(id: string): boolean {
    const file = this.read();
    if (file.connections[id] === undefined) {
      return false;
    }
    const connections = Object.fromEntries(
      Object.entries(file.connections).filter(([key]) => key !== id),
    );
    this.write({ connections });
    return true;
  }

  private read(): ConnectionsFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { connections: {} };
      }
      const record = parsed as { connections?: unknown };
      if (
        typeof record.connections !== "object" ||
        record.connections === null ||
        Array.isArray(record.connections)
      ) {
        return { connections: {} };
      }
      return { connections: record.connections as Record<string, ConnectionRecord> };
    } catch (error) {
      if (isMissingFile(error)) {
        return { connections: {} };
      }
      throw error;
    }
  }

  private write(file: ConnectionsFile): void {
    atomicWriteFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

export function connectionsPath(home: string): string {
  return join(home, "connections.json");
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
