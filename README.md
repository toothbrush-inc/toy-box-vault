# @local/vault

OSS connection vault for local-first capability apps (CalSync, weather-compare, and later others). Secrets live in the OS user data dir / Keychain, never in chat, never in a capability’s ledger.

```sh
npm install github:davidd8/local-vault
```

Default home (overridable with `VAULT_HOME`):

- macOS: `~/Library/Application Support/local-vault` (Keychain backend)
- Linux: `$XDG_DATA_HOME/local-vault` or `~/.local/share/local-vault` (file backend)
- Windows: `%APPDATA%\local-vault` (file backend)

`connect_provider` in a capability returns a loopback URL. The secret is posted in the browser. Tool results are masked status only.

## Grants

A grant is a row: capability `weather` may use connection `purpleair:default`.
Rows live in `grants.json` next to `connections.json` in the vault home.

- **Local default:** `VAULT_GRANT_MODE=auto` (or unset). The OS user may use any
  connection. No extra permission prompt on a laptop. `getSecretFor` succeeds
  without a row.
- **Explicit:** `VAULT_GRANT_MODE=explicit` requires `putGrant` before
  `getSecretFor`. Use this for hosted-like tests.

Capability manifests (`capability.json` at each app's package root) live
**in each app**, not here. A new capability must not require a vault release.
Parse them with `parseCapabilityManifest`; map a connected provider/slot to a
grant with `grantFromManifest`. `putGrant` does not require the connection to
exist yet; grant rows are inert until `getSecretFor` consults them. Fetchers
should call `getSecretFor(capability, connectionId)`; status/CLI may still call
`getSecret`.

The full contract a new app must implement — manifest schema, naming rules,
vault usage, grant modes, MCP conventions, acceptance checklist — is in
[CAPABILITY.md](CAPABILITY.md).

The **broker** that attaches keys only to allowlisted hosts, and a hosted
**data-store** for public / user / private data, are later packages. See
[FUTURE.md](FUTURE.md).

## Local vs hosted

Same tools, two runtimes. Do not fork handlers.

1. **Capability repos are independently useful.** Clone weather or calsync, `npm install`, run. The platform/gateway is optional locally and the default hosted.
2. **Credentials are one OSS package.** Apps depend on `@local/vault` via `package.json`, never a relative sibling path.
3. **Local identity = OS user.** No account. Auto-grant: anything running as that user may use that user’s connections. Zero extra permission prompts on a laptop.
4. **Hosted identity = login + grants** (not implemented here). Auth.js for humans, MCP OAuth for agents. Install/grant screen. Jobs carry `user_id` only. Same `connect_provider` tool; URL is `https://…/connect` instead of `127.0.0.1`.
5. **Adapters, not forks.** Tool handlers, fetchers, and ledgers do not branch on “hosted”. Secret store, identity, and job runner are the swap points.
6. **Standalone stdio MCP is the OSS unit.** One gateway process is the hosted unit (and an optional local composer). A capability must keep working if the user never installs the others.
7. **Optional connections stay optional.** Open-Meteo and PurpleAir are optional for weather. Google is required only for calsync.

## Scripts

```sh
npm test
npm run build
```
