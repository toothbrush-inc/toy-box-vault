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
