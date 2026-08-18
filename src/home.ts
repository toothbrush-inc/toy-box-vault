import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_KEYCHAIN_SERVICE = "com.local.vault";

export function defaultVaultHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "local-vault");
  }
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData !== undefined && appData.trim() !== "") {
      return join(appData, "local-vault");
    }
    return join(homedir(), "AppData", "Roaming", "local-vault");
  }
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(xdg, "local-vault");
  }
  return join(homedir(), ".local", "share", "local-vault");
}

/** Default vault home for this process (darwin Application Support on this Mac). */
export const DEFAULT_VAULT_HOME = defaultVaultHome();

export function resolveVaultHome(
  home?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (home !== undefined && home.trim() !== "") {
    return home;
  }
  const fromEnv = env["VAULT_HOME"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return defaultVaultHome(platform, env);
}
