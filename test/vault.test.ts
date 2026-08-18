import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiKeyLoopback,
  connectionId,
  DEFAULT_VAULT_HOME,
  defaultVaultHome,
  KeychainError,
  KeychainSecretStore,
  LoopbackServer,
  maskSecret,
  openVault,
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

function fileVault() {
  const home = mkdtempSync(join(tmpdir(), "vault-"));
  homes.push(home);
  return openVault({ home, backend: "file" });
}
