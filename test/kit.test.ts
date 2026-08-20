import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { grantFromManifest, openVault, parseCapabilityManifest } from "../src/index.js";
import { commonsDataset, fail, jsonResult, ok, peerCall, profileContext } from "../src/kit.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-"));
  dirs.push(dir);
  return dir;
}

async function fakeEgress(handler: (path: string) => { status: number; payload: unknown }): Promise<string> {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      const { status, payload } = handler(request.url ?? "/");
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("kit result envelope", () => {
  it("wraps, sanitizes, and flags errors", () => {
    const good = jsonResult(ok({ note: "fine", api_key: "SECRET", deep: { token: "x", keep: 1 } }));
    expect(good.isError).toBeUndefined();
    expect(good.structuredContent).toEqual({ ok: true, data: { note: "fine", deep: { keep: 1 } } });
    expect(good.content[0]?.text).not.toContain("SECRET");

    const bad = jsonResult(fail(new Error("leaked ya29.abc-def token"), "boom"));
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as { error: { code: string } }).error.code).toBe("boom");
    expect(bad.content[0]?.text).not.toContain("ya29.abc-def");

    const coded = Object.assign(new Error("x"), { code: "grant_missing" });
    expect(fail(coded, "fallback").error.code).toBe("grant_missing");
  });
});

describe("kit profileContext", () => {
  it("reads directly standalone and degrades with a note when ungranted", async () => {
    const home = tempDir();
    const env = { VAULT_HOME: home, VAULT_SECRETS_BACKEND: "file" } as NodeJS.ProcessEnv;
    openVault({ home, backend: "file" }).putProfile({ units: "metric" });

    const auto = await profileContext("books", ["units", "timezone"], { units: "imperial", timezone: "UTC" }, env);
    expect(auto).toEqual({ values: { units: "metric", timezone: "UTC" }, source: "profile" });

    const explicitEnv = { ...env, VAULT_GRANT_MODE: "explicit" } as NodeJS.ProcessEnv;
    const denied = await profileContext("books", ["units"], { units: "imperial" }, explicitEnv);
    expect(denied.source).toBe("default");
    expect(denied.values["units"]).toBe("imperial");
    expect(denied.note).toContain("grant profile:default");

    const manifest = parseCapabilityManifest({
      id: "books",
      connections: [{ provider: "profile", slot: "default", optional: true, actions: ["units"] }],
    });
    openVault({ home, backend: "file" }).putGrant(grantFromManifest(manifest, "profile", "default"));
    const granted = await profileContext("books", ["units"], { units: "imperial" }, explicitEnv);
    expect(granted).toEqual({ values: { units: "metric" }, source: "profile" });
  });

  it("uses the broker when egress env is present", async () => {
    const url = await fakeEgress(() => ({ status: 200, payload: { ok: true, fields: { units: "metric" } } }));
    const context = await profileContext("books", ["units"], { units: "imperial" }, {
      VAULT_EGRESS_URL: url,
      VAULT_EGRESS_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(context).toEqual({ values: { units: "metric" }, source: "profile" });
  });
});

describe("kit commonsDataset", () => {
  it("walks broker, dir, bundled, none", async () => {
    const url = await fakeEgress(() => ({
      status: 200,
      payload: { ok: true, dataset: "cat", data: { from: "broker" } },
    }));
    const brokered = await commonsDataset("cat", {
      env: { VAULT_EGRESS_URL: url, VAULT_EGRESS_TOKEN: "t" } as NodeJS.ProcessEnv,
    });
    expect(brokered).toEqual({ data: { from: "broker" }, source: "broker" });

    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cat.json"), JSON.stringify({ from: "dir" }));
    const fromDir = await commonsDataset("cat", { env: { COMMONS_DIR: dir } as NodeJS.ProcessEnv });
    expect(fromDir).toEqual({ data: { from: "dir" }, source: "dir" });

    const bundled = await commonsDataset("cat", { bundled: () => ({ from: "bundle" }), env: {} as NodeJS.ProcessEnv });
    expect(bundled).toEqual({ data: { from: "bundle" }, source: "bundled" });

    const none = await commonsDataset("cat", { env: {} as NodeJS.ProcessEnv });
    expect(none).toEqual({ data: null, source: "none" });
  });
});

describe("kit peerCall", () => {
  it("degrades gracefully standalone (no broker)", async () => {
    const result = await peerCall("fitness", "get_workout_stats", {}, {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("peer_unavailable");
    expect(result.note).toContain("gateway");
  });

  it("unwraps the producer envelope and carries provenance through the broker", async () => {
    const url = await fakeEgress(() => ({
      status: 200,
      payload: {
        ok: true,
        result: { ok: true, data: { total_workouts: 3 } },
        provenance: { capability: "fitness", version: "0.2.0", ts: "2026-08-20T12:00:00.000Z" },
      },
    }));
    const env = { VAULT_EGRESS_URL: url, VAULT_EGRESS_TOKEN: "t" } as NodeJS.ProcessEnv;
    const result = await peerCall("fitness", "get_workout_stats", { days: 7 }, env);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ total_workouts: 3 });
    expect(result.provenance?.capability).toBe("fitness");
    expect(result.provenance?.version).toBe("0.2.0");
  });

  it("maps grant denial to an actionable note and passes producer errors through", async () => {
    const denyUrl = await fakeEgress(() => ({
      status: 403,
      payload: { ok: false, error: { code: "grant_missing", message: "capability:fitness" } },
    }));
    const denied = await peerCall("fitness", "get_workout_stats", {}, {
      VAULT_EGRESS_URL: denyUrl,
      VAULT_EGRESS_TOKEN: "t",
    } as NodeJS.ProcessEnv);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("grant_missing");
    expect(denied.note).toContain("grant capability:fitness");

    const producerFailUrl = await fakeEgress(() => ({
      status: 200,
      payload: {
        ok: true,
        result: { ok: false, error: { code: "unknown_exercise", message: "no such exercise" } },
        provenance: { capability: "fitness", version: null, ts: "2026-08-20T12:00:00.000Z" },
      },
    }));
    const producerFail = await peerCall("fitness", "log_workout", { exercise: "flying" }, {
      VAULT_EGRESS_URL: producerFailUrl,
      VAULT_EGRESS_TOKEN: "t",
    } as NodeJS.ProcessEnv);
    expect(producerFail.ok).toBe(false);
    expect(producerFail.error?.code).toBe("unknown_exercise");
    expect(producerFail.provenance?.version).toBeNull();
  });
});

describe("manifest private ledger env/file", () => {
  it("parses env and file, rejecting malformed values", () => {
    const manifest = parseCapabilityManifest({
      id: "books",
      connections: [],
      data: { private: [{ name: "books", env: "BOOKS_DB", file: "books.json" }] },
    });
    expect(manifest.data?.private?.[0]).toEqual({ name: "books", env: "BOOKS_DB", file: "books.json" });

    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], data: { private: [{ name: "a", env: "lower" }] } }),
    ).toThrow(/UPPER_SNAKE_CASE/);
    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], data: { private: [{ name: "a", file: "../evil" }] } }),
    ).toThrow(/bare filename/);
  });
});
