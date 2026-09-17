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

  it("never joins a non-identifier dataset name into a path", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "secret"), { recursive: true });
    writeFileSync(join(dir, "secret", "keys.json"), JSON.stringify({ leaked: true }));
    const env = { COMMONS_DIR: join(dir, "public") } as NodeJS.ProcessEnv;
    for (const name of ["../secret/keys", "/abs/keys", "Cat", "a b", ""]) {
      expect(await commonsDataset(name, { env })).toEqual({ data: null, source: "none" });
    }
    const bundled = await commonsDataset("../secret/keys", { env, bundled: { own: true } });
    expect(bundled).toEqual({ data: { own: true }, source: "bundled" });
  });
});

describe("kit peerCall", () => {
  it("degrades gracefully standalone (no broker)", async () => {
    const result = await peerCall("books", "get_reading_stats", {}, {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("peer_unavailable");
    expect(result.note).toContain("gateway");
  });

  it("unwraps the producer envelope and carries provenance through the broker", async () => {
    const url = await fakeEgress(() => ({
      status: 200,
      payload: {
        ok: true,
        result: { ok: true, data: { total_books: 3 } },
        provenance: { capability: "books", version: "0.2.0", ts: "2026-08-20T12:00:00.000Z" },
      },
    }));
    const env = { VAULT_EGRESS_URL: url, VAULT_EGRESS_TOKEN: "t" } as NodeJS.ProcessEnv;
    const result = await peerCall("books", "get_reading_stats", { days: 7 }, env);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ total_books: 3 });
    expect(result.provenance?.capability).toBe("books");
    expect(result.provenance?.version).toBe("0.2.0");
  });

  it("maps grant denial to an actionable note and passes producer errors through", async () => {
    const denyUrl = await fakeEgress(() => ({
      status: 403,
      payload: { ok: false, error: { code: "grant_missing", message: "capability:books" } },
    }));
    const denied = await peerCall("books", "get_reading_stats", {}, {
      VAULT_EGRESS_URL: denyUrl,
      VAULT_EGRESS_TOKEN: "t",
    } as NodeJS.ProcessEnv);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("grant_missing");
    expect(denied.note).toContain("grant capability:books");

    const producerFailUrl = await fakeEgress(() => ({
      status: 200,
      payload: {
        ok: true,
        result: { ok: false, error: { code: "unknown_exercise", message: "no such exercise" } },
        provenance: { capability: "books", version: null, ts: "2026-08-20T12:00:00.000Z" },
      },
    }));
    const producerFail = await peerCall("books", "log_book", { exercise: "flying" }, {
      VAULT_EGRESS_URL: producerFailUrl,
      VAULT_EGRESS_TOKEN: "t",
    } as NodeJS.ProcessEnv);
    expect(producerFail.ok).toBe(false);
    expect(producerFail.error?.code).toBe("unknown_exercise");
    expect(producerFail.provenance?.version).toBeNull();
  });
});

describe("manifest tools.query", () => {
  it("parses, normalizes, dedupes, and rejects malformed names", () => {
    const manifest = parseCapabilityManifest({
      id: "books",
      connections: [],
      tools: { query: ["get_reading_stats", "Get_Reading_Stats", "get_status"] },
    });
    expect(manifest.tools?.query).toEqual(["get_reading_stats", "get_status"]);

    expect(parseCapabilityManifest({ id: "x", connections: [] }).tools).toBeUndefined();
    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], tools: { query: ["bad-name"] } }),
    ).toThrow(/tools.query entry/);
    expect(() => parseCapabilityManifest({ id: "x", connections: [], tools: [] })).toThrow(
      /tools must be an object/,
    );
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

describe("manifest store", () => {
  it("parses the storefront block and enforces its limits", () => {
    const manifest = parseCapabilityManifest({
      id: "weather",
      connections: [],
      store: {
        name: " Weather ",
        tagline: "Know which forecast to trust.",
        description: "Three forecasts side by side.",
        highlights: ["Air quality near you", "A heads-up when tomorrow is odd"],
        badge: "beta",
        accent: "sky",
        web: { path: "/weather" },
        repo: "https://github.com/davidd8/weather-compare",
      },
    });
    expect(manifest.store).toEqual({
      name: "Weather",
      tagline: "Know which forecast to trust.",
      description: "Three forecasts side by side.",
      highlights: ["Air quality near you", "A heads-up when tomorrow is odd"],
      badge: "beta",
      accent: "sky",
      web: { path: "/weather" },
      repo: "https://github.com/davidd8/weather-compare",
    });

    expect(parseCapabilityManifest({ id: "x", connections: [] }).store).toBeUndefined();
    expect(parseCapabilityManifest({ id: "x", connections: [], store: { name: "X" } }).store).toEqual({
      name: "X",
    });
    expect(() => parseCapabilityManifest({ id: "x", connections: [], store: {} })).toThrow(
      /store.name is required/,
    );
    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], store: { name: "X", tagline: "t".repeat(121) } }),
    ).toThrow(/store.tagline must be at most 120/);
    expect(() =>
      parseCapabilityManifest({
        id: "x",
        connections: [],
        store: { name: "X", highlights: ["a", "b", "c", "d", "e"] },
      }),
    ).toThrow(/highlights must have at most 4/);
    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], store: { name: "X", accent: "teal" } }),
    ).toThrow(/store.accent must be one of/);
    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], store: { name: "X", web: { path: "weather" } } }),
    ).toThrow(/store.web.path must be an absolute path/);
    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], store: { name: "X", repo: "github.com/x" } }),
    ).toThrow(/store.repo must be an http\(s\) URL/);
  });
});
