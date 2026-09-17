import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiKeyLoopback,
  brokeredCall,
  brokeredGet,
  brokeredToken,
  capabilityConnectionId,
  connectionId,
  DEFAULT_VAULT_HOME,
  defaultVaultHome,
  egressFromEnv,
  EgressRequiredError,
  GrantError,
  grantFromManifest,
  brokeredCommons,
  brokeredProfile,
  KeychainError,
  ProfileBoundsError,
  KeychainSecretStore,
  LoopbackServer,
  maskSecret,
  openVault,
  parseCapabilityManifest,
  resolveVaultHome,
  type CommandRunner,
} from "../src/index.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("connection records", () => {
  it("stores a secret, returns masked status, and never echoes the secret", async () => {
    const vault = fileVault();
    await vault.putSecret({
      provider: "google",
      slot: "personal",
      kind: "oauth",
      secret: "1//refresh-token-secret",
      scopes: ["calendar.events"],
      now: new Date("2026-08-17T21:00:00.000Z"),
    });

    const status = await vault.status("google:personal");
    expect(status).toMatchObject({
      id: "google:personal",
      provider: "google",
      slot: "personal",
      kind: "oauth",
      status: "ok",
      set: true,
      origin: "vault",
      masked: "••••cret",
      scopes: ["calendar.events"],
      validatedAt: "2026-08-17T21:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain("1//refresh-token-secret");
    await expect(vault.getSecret("google:personal")).resolves.toBe("1//refresh-token-secret");
  });

  it("reports missing when neither metadata nor secret exist", async () => {
    const vault = fileVault();
    await expect(vault.status(connectionId("google", "work"))).resolves.toMatchObject({
      set: false,
      origin: "none",
      status: "missing",
      masked: "",
    });
  });

  it("revokes both the secret and the connection row", async () => {
    const vault = fileVault();
    await vault.putSecret({
      provider: "google",
      slot: "work",
      kind: "oauth",
      secret: "work-refresh",
    });

    await expect(vault.revoke("google:work")).resolves.toBe(true);
    await expect(vault.getSecret("google:work")).resolves.toBeNull();
    await expect(vault.status("google:work")).resolves.toMatchObject({
      set: false,
      status: "missing",
    });
  });
});

describe("resolveVaultHome", () => {
  it("uses a stable Application Support path, not process.cwd()", () => {
    expect(resolveVaultHome(undefined, {})).toBe(DEFAULT_VAULT_HOME);
    expect(resolveVaultHome(undefined, {})).not.toBe(process.cwd());
    expect(resolveVaultHome(undefined, { VAULT_HOME: "/tmp/shared-vault" })).toBe(
      "/tmp/shared-vault",
    );
    expect(resolveVaultHome("/explicit", { VAULT_HOME: "/tmp/shared-vault" })).toBe("/explicit");
  });

  it("uses XDG on linux and APPDATA on win32", () => {
    expect(defaultVaultHome("linux", {})).toBe(join(homedir(), ".local", "share", "local-vault"));
    expect(defaultVaultHome("linux", { XDG_DATA_HOME: "/xdg" })).toBe(join("/xdg", "local-vault"));
    expect(resolveVaultHome(undefined, {}, "linux")).toBe(
      join(homedir(), ".local", "share", "local-vault"),
    );
    expect(defaultVaultHome("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" })).toBe(
      join("C:\\Users\\x\\AppData\\Roaming", "local-vault"),
    );
  });
});

describe("maskSecret", () => {
  it("hides short values entirely and keeps the last four of longer ones", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("abcd")).toBe("••••");
    expect(maskSecret("purpleair-read-key")).toBe("••••-key");
  });
});

describe("KeychainSecretStore", () => {
  it("stores connection ids as generic-password accounts", async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "" });
    const store = new KeychainSecretStore({ service: "test.vault", run, platform: "darwin" });

    await store.set("google:personal", "personal-refresh-token");

    expect(run).toHaveBeenCalledWith("security", [
      "add-generic-password",
      "-U",
      "-a",
      "google:personal",
      "-s",
      "test.vault",
      "-w",
      "personal-refresh-token",
    ]);
  });

  it("treats a missing Keychain item as unset", async () => {
    const error = Object.assign(new Error("missing"), {
      code: 44,
      stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found.",
    });
    const run = vi.fn<CommandRunner>().mockRejectedValue(error);
    const store = new KeychainSecretStore({ service: "test.vault", run, platform: "darwin" });

    await expect(store.get("google:personal")).resolves.toBeNull();
    await expect(store.delete("google:personal")).resolves.toBe(false);
  });

  it("rejects unsupported platforms and empty secrets", async () => {
    expect(
      () => new KeychainSecretStore({ service: "test.vault", run: vi.fn(), platform: "linux" }),
    ).toThrow(KeychainError);

    const store = new KeychainSecretStore({
      service: "test.vault",
      run: vi.fn<CommandRunner>(),
      platform: "darwin",
    });
    await expect(store.set("google:work", " ")).rejects.toThrow("empty secret");
  });
});

describe("LoopbackServer", () => {
  it("captures oauth query params on the loopback port", async () => {
    const server = await LoopbackServer.start({
      path: "/oauth2callback",
      successText: "calsync authorization complete. You can close this window.",
      timeoutMs: 5_000,
    });
    try {
      const pending = server.waitForParams();
      const response = await fetch(`${server.redirectUri}?code=auth-code&state=csrf`);
      expect(response.ok).toBe(true);
      expect(await response.text()).toContain("authorization complete");
      const params = await pending;
      expect(params.get("code")).toBe("auth-code");
      expect(params.get("state")).toBe("csrf");
    } finally {
      server.close();
    }
  });

  it("advertises a public callback URL while still capturing on the local port", async () => {
    const server = await LoopbackServer.start({
      path: "/oauth2callback/personal",
      publicBaseUrl: "https://gw.example.com/",
      timeoutMs: 5_000,
    });
    try {
      expect(server.redirectUri).toBe("https://gw.example.com/oauth2callback/personal");
      const pending = server.waitForParams();
      const address = (server as unknown as { server: { address(): { port: number } } }).server.address();
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/oauth2callback/personal?code=pub-code`,
      );
      expect(response.ok).toBe(true);
      expect((await pending).get("code")).toBe("pub-code");
    } finally {
      server.close();
    }
  });

  it("binds a fixed port when asked", async () => {
    const first = await LoopbackServer.start({ port: 0, timeoutMs: 5_000 });
    const port = Number(new URL(first.redirectUri).port);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await LoopbackServer.start({ port, timeoutMs: 5_000 });
    try {
      expect(new URL(second.redirectUri).port).toBe(String(port));
    } finally {
      second.close();
    }
  });

  it("ignores requests to other paths so the callback can still complete", async () => {
    const server = await LoopbackServer.start({ path: "/oauth2callback", timeoutMs: 5_000 });
    try {
      const pending = server.waitForParams();
      const favicon = await fetch(new URL("/favicon.ico", server.redirectUri));
      expect(favicon.status).toBe(404);
      const response = await fetch(`${server.redirectUri}?code=second`);
      expect(response.ok).toBe(true);
      expect((await pending).get("code")).toBe("second");
    } finally {
      server.close();
    }
  });
});

describe("ApiKeyLoopback", () => {
  const page = {
    title: "Connect PurpleAir",
    heading: "PurpleAir READ key",
    message: "Paste the key. It stays on this machine.",
    fieldLabel: "READ key",
    helpUrl: "https://develop.purpleair.com",
    helpLabel: "Get a free READ key",
  };

  it("serves a form and captures a posted key without echoing it", async () => {
    const server = await ApiKeyLoopback.start({
      page,
      timeoutMs: 5_000,
      state: "csrf-state-token",
    });
    try {
      const pending = server.waitForSecret();
      const form = await fetch(server.url);
      const html = await form.text();
      expect(form.ok).toBe(true);
      expect(html).toContain("PurpleAir READ key");
      expect(html).toContain("https://develop.purpleair.com");
      expect(html).not.toContain("super-secret-key");

      const posted = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=csrf-state-token&api_key=super-secret-key",
      });
      const done = await posted.text();
      expect(posted.ok).toBe(true);
      expect(done).toContain("Connected");
      expect(done).not.toContain("super-secret-key");
      await expect(pending).resolves.toBe("super-secret-key");
    } finally {
      server.close();
    }
  });

  it("never reveals the state to a request that did not present it", async () => {
    const server = await ApiKeyLoopback.start({ page, timeoutMs: 5_000, state: "hidden-state" });
    try {
      const pending = server.waitForSecret();
      const origin = server.url.slice(0, server.url.indexOf("/connect"));

      const bare = await fetch(`${origin}/connect`);
      expect(bare.status).toBe(403);
      expect(await bare.text()).not.toContain("hidden-state");

      const wrongGet = await fetch(`${origin}/connect?state=guess`);
      expect(wrongGet.status).toBe(403);
      expect(await wrongGet.text()).not.toContain("hidden-state");

      const wrongPost = await fetch(`${origin}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=guess&api_key=stolen",
      });
      expect(wrongPost.status).toBe(403);
      expect(await wrongPost.text()).not.toContain("hidden-state");

      const real = await fetch(server.url);
      expect(real.status).toBe(200);
      expect(await real.text()).toContain('value="hidden-state"');

      const posted = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=hidden-state&api_key=the-real-key",
      });
      expect(posted.ok).toBe(true);
      await expect(pending).resolves.toBe("the-real-key");
    } finally {
      server.close();
    }
  });

  it("advertises a public connect URL carrying the state", async () => {
    const server = await ApiKeyLoopback.start({
      page,
      path: "/connect/purpleair",
      publicBaseUrl: "https://gw.example.com",
      state: "public-state",
      timeoutMs: 5_000,
    });
    try {
      expect(server.url).toBe("https://gw.example.com/connect/purpleair?state=public-state");
    } finally {
      server.close();
    }
  });

  it("accepts an empty submission for keyless providers (allowEmpty)", async () => {
    const server = await ApiKeyLoopback.start({
      page: { ...page, allowEmpty: true, message: "Optional; the public API needs no key." },
      timeoutMs: 5_000,
      state: "keyless-state",
    });
    try {
      const pending = server.waitForSecret();
      const html = await (await fetch(server.url)).text();
      expect(html).toContain("Continue without a key");
      const posted = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=keyless-state&api_key=",
      });
      expect(posted.ok).toBe(true);
      await expect(pending).resolves.toBe("");
    } finally {
      server.close();
    }
  });

  it("rejects an empty key and a mismatched state", async () => {
    const server = await ApiKeyLoopback.start({ page, timeoutMs: 5_000, state: "expected-state" });
    try {
      const empty = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=expected-state&api_key=",
      });
      expect(empty.status).toBe(400);

      const forged = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=wrong&api_key=stolen",
      });
      expect(forged.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe("grants", () => {
  it("auto-grants getSecretFor so a laptop needs no extra rows", async () => {
    const vault = fileVault();
    await vault.putSecret({
      provider: "purpleair",
      slot: "default",
      kind: "apikey",
      secret: "pa-secret",
    });

    await expect(vault.getSecretFor("weather", "purpleair:default")).resolves.toBe("pa-secret");
    expect(vault.checkGrant({ capability: "weather", connectionId: "purpleair:default" })).toBe(true);
    expect(vault.listGrants()).toEqual([]);
  });

  it("explicit mode requires a grant row before getSecretFor", async () => {
    const vault = fileVault("explicit");
    await vault.putSecret({
      provider: "purpleair",
      slot: "default",
      kind: "apikey",
      secret: "pa-secret",
    });

    await expect(vault.getSecretFor("weather", "purpleair:default")).rejects.toBeInstanceOf(GrantError);
    expect(vault.checkGrant({ capability: "weather", connectionId: "purpleair:default" })).toBe(false);

    vault.putGrant({
      capability: "weather",
      connectionId: "purpleair:default",
      actions: ["read"],
      now: new Date("2026-08-18T20:00:00.000Z"),
    });

    await expect(vault.getSecretFor("weather", "purpleair:default", "read")).resolves.toBe("pa-secret");
    expect(vault.checkGrant({ capability: "weather", connectionId: "purpleair:default", action: "write" })).toBe(
      false,
    );
    expect(vault.listGrants("weather")).toMatchObject([
      { id: "weather:purpleair:default", capability: "weather", connectionId: "purpleair:default", actions: ["read"] },
    ]);
  });

  it("revoke of a connection deletes its grant rows", async () => {
    const vault = fileVault("explicit");
    await vault.putSecret({
      provider: "google",
      slot: "personal",
      kind: "oauth",
      secret: "1//refresh",
    });
    vault.putGrant({ capability: "calsync", connectionId: "google:personal" });
    vault.putGrant({ capability: "weather", connectionId: "purpleair:default" });

    await vault.revoke("google:personal");
    expect(vault.listGrants("calsync")).toEqual([]);
    expect(vault.listGrants("weather")).toMatchObject([{ connectionId: "purpleair:default" }]);
  });
});

describe("parseCapabilityManifest", () => {
  it("normalizes a capability's connection needs", () => {
    expect(
      parseCapabilityManifest({
        id: "Weather",
        connections: [
          { provider: "PurpleAir", slot: "Default", optional: true, actions: ["read"] },
          { provider: "open_meteo", slot: "default", optional: true },
        ],
      }),
    ).toEqual({
      id: "weather",
      connections: [
        { provider: "purpleair", slot: "default", optional: true, actions: ["read"] },
        { provider: "open_meteo", slot: "default", optional: true },
      ],
    });
  });

  it("rejects a malformed manifest", () => {
    expect(() => parseCapabilityManifest({ id: "weather" })).toThrow(/connections must be an array/);
  });

  it("maps a declared connection need to a grant input", () => {
    const manifest = parseCapabilityManifest({
      id: "weather",
      connections: [
        { provider: "purpleair", slot: "default", optional: true, actions: ["read"] },
        { provider: "open_meteo", slot: "default", optional: true },
      ],
    });

    expect(grantFromManifest(manifest, "purpleair", "default")).toEqual({
      capability: "weather",
      connectionId: "purpleair:default",
      actions: ["read"],
    });
    expect(grantFromManifest(manifest, "open_meteo", "default")).toEqual({
      capability: "weather",
      connectionId: "open_meteo:default",
    });
    expect(() => grantFromManifest(manifest, "google", "personal")).toThrow(
      /does not declare connection google:personal/,
    );
  });

  it("parses egress specs and rejects malformed ones", () => {
    const manifest = parseCapabilityManifest({
      id: "weather",
      connections: [
        {
          provider: "purpleair",
          slot: "default",
          optional: true,
          egress: { hosts: ["Api.PurpleAir.com"], attach: { kind: "header", name: "X-API-Key" } },
        },
        {
          provider: "open_meteo",
          slot: "default",
          optional: true,
          egress: {
            hosts: ["api.open-meteo.com"],
            attach: { kind: "query", name: "apikey" },
            hostRewrite: { "api.open-meteo.com": "customer-api.open-meteo.com" },
          },
        },
      ],
    });
    expect(manifest.connections[0]?.egress).toEqual({
      hosts: ["api.purpleair.com"],
      attach: { kind: "header", name: "X-API-Key" },
    });
    expect(manifest.connections[1]?.egress?.hostRewrite).toEqual({
      "api.open-meteo.com": "customer-api.open-meteo.com",
    });

    const base = { provider: "p", slot: "default", optional: true };
    const withEgress = (egress: unknown) => ({ id: "x", connections: [{ ...base, egress }] });
    expect(() => parseCapabilityManifest(withEgress({ hosts: [], attach: { kind: "header", name: "K" } }))).toThrow(
      /hosts must be a non-empty array/,
    );
    expect(() =>
      parseCapabilityManifest(withEgress({ hosts: ["https://a.com"], attach: { kind: "header", name: "K" } })),
    ).toThrow(/bare hostnames/);
    expect(() =>
      parseCapabilityManifest(withEgress({ hosts: ["a.com"], attach: { kind: "cookie", name: "K" } })),
    ).toThrow(/attach.kind/);
    expect(() =>
      parseCapabilityManifest(withEgress({ hosts: ["a.com"], attach: { kind: "header", name: " " } })),
    ).toThrow(/attach.name/);
  });

  it("keeps manifests without egress backward compatible", () => {
    const manifest = parseCapabilityManifest({
      id: "calsync",
      connections: [{ provider: "google", slot: "personal", optional: false }],
    });
    expect(manifest.connections[0]).not.toHaveProperty("egress");
  });

  it("registers grants that satisfy explicit-mode getSecretFor", async () => {
    const vault = fileVault("explicit");
    await vault.putSecret({
      provider: "purpleair",
      slot: "default",
      kind: "apikey",
      secret: "pa-secret",
    });
    const manifest = parseCapabilityManifest({
      id: "weather",
      connections: [{ provider: "purpleair", slot: "default", optional: true, actions: ["read"] }],
    });

    vault.putGrant(grantFromManifest(manifest, "purpleair", "default"));

    await expect(vault.getSecretFor("weather", "purpleair:default", "read")).resolves.toBe("pa-secret");
  });
});

describe("profile", () => {
  const PROFILE_MANIFEST = {
    id: "fitness",
    connections: [
      { provider: "profile", slot: "default", optional: true, actions: ["units", "timezone"] },
    ],
  };

  it("merges, deletes, and reads owner-side without grants", () => {
    const vault = fileVault();
    vault.putProfile({ units: "metric", timezone: "America/Los_Angeles" });
    vault.putProfile({ units: "imperial" });
    expect(vault.getProfile()).toEqual({ units: "imperial", timezone: "America/Los_Angeles" });
    expect(vault.deleteProfileField("timezone")).toBe(true);
    expect(vault.deleteProfileField("timezone")).toBe(false);
    expect(vault.getProfile()).toEqual({ units: "imperial" });
  });

  it("enforces the not-a-data-lake bounds", () => {
    const vault = fileVault();
    expect(() => vault.putProfile({ units: "" })).toThrow(/must not be empty/);
    expect(() => vault.putProfile({ "Bad Field": "x" })).toThrow(/not a valid profile field/);
    expect(() => vault.putProfile({ units: "x".repeat(257) })).toThrow(ProfileBoundsError);
    const many: Record<string, string> = {};
    for (let index = 0; index < 33; index += 1) {
      many[`field-${String(index)}`] = "v";
    }
    expect(() => vault.putProfile(many)).toThrow(/32 fields/);
  });

  it("gates reads per field in explicit mode and returns only set fields", async () => {
    const vault = fileVault("explicit");
    vault.putProfile({ units: "metric" });
    const manifest = parseCapabilityManifest(PROFILE_MANIFEST);

    await expect(vault.getProfileFor("fitness", ["units"])).rejects.toBeInstanceOf(GrantError);
    vault.putGrant(grantFromManifest(manifest, "profile", "default"));

    await expect(vault.getProfileFor("fitness", ["units", "timezone"])).resolves.toEqual({
      units: "metric", // timezone granted but unset -> omitted
    });
    const denied = await vault.getProfileFor("fitness", ["birthday"]).then(
      () => null,
      (error: Error) => error,
    );
    expect(denied?.message).toContain("birthday");
  });

  it("treats an empty actions list as no fields for profile, but all actions for credentials", async () => {
    const vault = fileVault("explicit");
    vault.putProfile({ units: "metric", birthday: "1990-01-01" });

    vault.putGrant({ capability: "fitness", connectionId: "profile:default" });
    await expect(vault.getProfileFor("fitness", ["units"])).rejects.toBeInstanceOf(GrantError);
    await expect(vault.getProfileFor("fitness", ["birthday"])).rejects.toBeInstanceOf(GrantError);
    expect(
      vault.checkGrant({ capability: "fitness", connectionId: "capability:weather", action: "get_forecast" }),
    ).toBe(false);
    vault.putGrant({ capability: "fitness", connectionId: "capability:weather" });
    expect(
      vault.checkGrant({ capability: "fitness", connectionId: "capability:weather", action: "get_forecast" }),
    ).toBe(false);

    await vault.putSecret({ provider: "strava", slot: "default", kind: "oauth", secret: "tok" });
    vault.putGrant({ capability: "fitness", connectionId: "strava:default" });
    await expect(vault.getSecretFor("fitness", "strava:default", "write")).resolves.toBe("tok");
  });

  it("keeps profile data when grants are revoked, and blocks reads in broker mode", async () => {
    const vault = fileVault("explicit");
    vault.putProfile({ units: "metric" });
    const manifest = parseCapabilityManifest(PROFILE_MANIFEST);
    vault.putGrant(grantFromManifest(manifest, "profile", "default"));
    vault.revokeGrant("fitness", "profile:default");
    await expect(vault.getProfileFor("fitness", ["units"])).rejects.toBeInstanceOf(GrantError);
    expect(vault.getProfile()).toEqual({ units: "metric" });

    const home = mkdtempSync(join(tmpdir(), "vault-"));
    homes.push(home);
    const brokered = openVault({
      home,
      backend: "file",
      env: { VAULT_SECRETS_ACCESS: "broker" },
    });
    await expect(brokered.getProfileFor("fitness", ["units"])).rejects.toThrow(/broker-only/);
    expect(() => brokered.putProfile({ units: "metric" })).not.toThrow();
  });

  it("parses the manifest data block and rejects malformed entries", () => {
    const manifest = parseCapabilityManifest({
      id: "fitness",
      connections: [{ provider: "profile", slot: "default", optional: true, actions: ["units"] }],
      data: {
        private: [{ name: "Workouts", description: "  Personal workout ledger  " }],
        commons: [{ dataset: "exercise-catalog" }],
      },
    });
    expect(manifest.data).toEqual({
      private: [{ name: "workouts", description: "Personal workout ledger" }],
      commons: [{ dataset: "exercise-catalog" }],
    });
    expect(grantFromManifest(manifest, "profile", "default").actions).toEqual(["units"]);

    expect(() =>
      parseCapabilityManifest({ id: "x", connections: [], data: { commons: [{ dataset: "no spaces" }] } }),
    ).toThrow(/data.commons\[0\].dataset/);
    expect(() => parseCapabilityManifest({ id: "x", connections: [], data: [] })).toThrow(
      /data must be an object/,
    );
  });

  it("reads profile and commons through the broker clients", async () => {
    const profileBroker = await fakeBroker(() => ({
      status: 200,
      payload: { ok: true, fields: { units: "metric" } },
    }));
    try {
      await expect(
        brokeredProfile({ url: profileBroker.url, token: "t" }, { fields: ["units", "timezone"] }),
      ).resolves.toEqual({ units: "metric" });
    } finally {
      await profileBroker.close();
    }

    const denyBroker = await fakeBroker(() => ({
      status: 403,
      payload: { ok: false, error: { code: "grant_missing", message: "fields: units" } },
    }));
    try {
      const denial = await brokeredProfile({ url: denyBroker.url, token: "t" }, { fields: ["units"] }).then(
        () => null,
        (error: Error & { code?: string }) => error,
      );
      expect(denial?.code).toBe("grant_missing");
    } finally {
      await denyBroker.close();
    }

    const commonsBroker = await fakeBroker(() => ({
      status: 200,
      payload: { ok: true, dataset: "exercise-catalog", data: { exercises: [{ name: "running" }] } },
    }));
    try {
      await expect(
        brokeredCommons({ url: commonsBroker.url, token: "t" }, { dataset: "exercise-catalog" }),
      ).resolves.toEqual({ exercises: [{ name: "running" }] });
    } finally {
      await commonsBroker.close();
    }
  });
});

describe("brokered egress client", () => {
  it("reads the endpoint from env, requiring both variables", () => {
    expect(egressFromEnv({})).toBeNull();
    expect(egressFromEnv({ VAULT_EGRESS_URL: "http://127.0.0.1:1" })).toBeNull();
    expect(
      egressFromEnv({ VAULT_EGRESS_URL: "http://127.0.0.1:1", VAULT_EGRESS_TOKEN: "t" }),
    ).toEqual({ url: "http://127.0.0.1:1", token: "t" });
  });

  it("returns broker 2xx replies as data, including upstream failures", async () => {
    const { url, close } = await fakeBroker((body) => ({
      status: 200,
      payload: { ok: true, status: 502, contentType: "text/plain", body: `echo:${body.url}` },
    }));
    try {
      const result = await brokeredGet(
        { url, token: "tok" },
        { provider: "purpleair", url: "https://api.purpleair.com/v1/sensors/1" },
      );
      expect(result).toEqual({
        status: 502,
        contentType: "text/plain",
        body: "echo:https://api.purpleair.com/v1/sensors/1",
      });
    } finally {
      await close();
    }
  });

  it("throws coded errors for broker denials and unreachable brokers", async () => {
    const { url, close } = await fakeBroker(() => ({
      status: 403,
      payload: { ok: false, error: { code: "grant_missing", message: "no grant" } },
    }));
    try {
      const denial = await brokeredGet(
        { url, token: "tok" },
        { provider: "purpleair", url: "https://api.purpleair.com/x" },
      ).then(
        () => null,
        (error: Error & { code?: string }) => error,
      );
      expect(denial?.code).toBe("grant_missing");
      expect(denial?.message).toBe("no grant");
    } finally {
      await close();
    }

    const unreachable = await brokeredGet(
      { url: "http://127.0.0.1:9", token: "tok" },
      { provider: "purpleair", url: "https://api.purpleair.com/x" },
    ).then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(unreachable?.code).toBe("egress_unreachable");
  });

  it("exchanges tokens via the broker and throws coded errors on denial", async () => {
    const ok = await fakeBroker(() => ({
      status: 200,
      payload: { ok: true, access_token: "ya29.short", expires_at: "2026-08-19T22:00:00.000Z" },
    }));
    try {
      await expect(
        brokeredToken({ url: ok.url, token: "tok" }, { provider: "google", slot: "personal" }),
      ).resolves.toEqual({ accessToken: "ya29.short", expiresAt: "2026-08-19T22:00:00.000Z" });
    } finally {
      await ok.close();
    }

    const revoked = await fakeBroker(() => ({
      status: 403,
      payload: { ok: false, error: { code: "token_revoked", message: "re-run connect" } },
    }));
    try {
      const denial = await brokeredToken(
        { url: revoked.url, token: "tok" },
        { provider: "google", slot: "personal" },
      ).then(
        () => null,
        (error: Error & { code?: string }) => error,
      );
      expect(denial?.code).toBe("token_revoked");
      expect(denial?.message).toBe("re-run connect");
    } finally {
      await revoked.close();
    }
  });

  it("calls peer capabilities via the broker with provenance, coded denials, malformed rejection", async () => {
    expect(capabilityConnectionId("fitness")).toBe("capability:fitness");

    const ok = await fakeBroker(() => ({
      status: 200,
      payload: {
        ok: true,
        result: { ok: true, data: { total: 3 } },
        provenance: { capability: "fitness", version: "0.2.0", ts: "2026-08-20T12:00:00.000Z" },
      },
    }));
    try {
      const call = await brokeredCall(
        { url: ok.url, token: "tok" },
        { capability: "fitness", tool: "get_workout_stats", args: { days: 7 } },
      );
      expect(call.result).toEqual({ ok: true, data: { total: 3 } });
      expect(call.provenance).toEqual({
        capability: "fitness",
        version: "0.2.0",
        ts: "2026-08-20T12:00:00.000Z",
      });
    } finally {
      await ok.close();
    }

    const denied = await fakeBroker(() => ({
      status: 403,
      payload: { ok: false, error: { code: "grant_missing", message: "capability:fitness" } },
    }));
    try {
      const denial = await brokeredCall(
        { url: denied.url, token: "tok" },
        { capability: "fitness", tool: "get_workout_stats" },
      ).then(
        () => null,
        (error: Error & { code?: string }) => error,
      );
      expect(denial?.code).toBe("grant_missing");
    } finally {
      await denied.close();
    }

    const malformed = await fakeBroker(() => ({ status: 200, payload: { ok: true, result: {} } }));
    try {
      const failure = await brokeredCall(
        { url: malformed.url, token: "tok" },
        { capability: "fitness", tool: "get_workout_stats" },
      ).then(
        () => null,
        (error: Error & { code?: string }) => error,
      );
      expect(failure?.code).toBe("egress_error");
    } finally {
      await malformed.close();
    }
  });
});

describe("broker-only secrets access", () => {
  it("blocks fetch-path reads but keeps status and display reads working", async () => {
    const home = mkdtempSync(join(tmpdir(), "vault-"));
    homes.push(home);
    const direct = openVault({ home, backend: "file" });
    await direct.putSecret({ provider: "purpleair", slot: "default", kind: "apikey", secret: "pa-key" });

    const brokered = openVault({ home, backend: "file", env: { VAULT_SECRETS_ACCESS: "broker" } });
    expect(brokered.secretsAccess).toBe("broker");
    await expect(brokered.getSecretFor("weather", "purpleair:default")).rejects.toBeInstanceOf(
      EgressRequiredError,
    );
    await expect(brokered.getSecret("purpleair:default")).resolves.toBe("pa-key");
    await expect(brokered.status("purpleair:default")).resolves.toMatchObject({ set: true });

    expect(direct.secretsAccess).toBe("direct");
    await expect(direct.getSecretFor("weather", "purpleair:default")).resolves.toBe("pa-key");
  });
});

async function fakeBroker(
  handle: (body: { provider: string; slot: string; url: string }) => {
    status: number;
    payload: unknown;
  },
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      const body = JSON.parse(raw) as { provider: string; slot: string; url: string };
      const { status, payload } = handle(body);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function fileVault(grantMode?: "auto" | "explicit") {
  const home = mkdtempSync(join(tmpdir(), "vault-"));
  homes.push(home);
  const options: { home: string; backend: "file"; grantMode?: "auto" | "explicit" } = { home, backend: "file" };
  if (grantMode !== undefined) {
    options.grantMode = grantMode;
  }
  return openVault(options);
}
