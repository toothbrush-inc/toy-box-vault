# toy-box vault

`@dvd-toy-box/vault` is a small local secrets vault for MCP "capabilities": apps
that run as a stdio MCP server on a user's machine and need credentials for outside services.
The package holds those credentials in the OS user's data directory or macOS
Keychain, records which capability may use which connection (grants), and
ships the two browser-based connect flows (OAuth loopback and an API-key
form) that get a secret into the vault without it ever passing through chat.

It is the client-side companion to
[capability-gateway](https://github.com/davidd8/capability-gateway), which
mounts several capabilities behind one MCP endpoint and enforces grants
centrally. A capability built on this package works standalone on a laptop
and unchanged under the gateway.

## Install

```sh
npm install @dvd-toy-box/vault
```

Requires Node 20 or newer. The `@dvd-toy-box` scope is the home for this and
the other toy-box packages.

To track a commit that is not on npm yet, install from GitHub instead, pinned
to a tag or commit:

```sh
npm install github:toothbrush-inc/toy-box-vault#<tag-or-sha>
```

```js
import { openVault, LoopbackServer, ApiKeyLoopback } from "@dvd-toy-box/vault";
import { jsonResult, profileContext, commonsDataset } from "@dvd-toy-box/vault/kit";
```

## What is in the box

- **`openVault()`** — the vault: `putSecret`, `getSecretFor`, `status`,
  `list`, `revoke`, plus grants (`putGrant`, `checkGrant`, `revokeGrant`) and
  the bounded user profile (`putProfile`, `getProfileFor`).
- **`LoopbackServer`** — a one-shot HTTP listener for an OAuth authorization
  code callback.
- **`ApiKeyLoopback`** — a one-shot local page where the user pastes an API
  key, for providers without OAuth.
- **`parseCapabilityManifest` / `grantFromManifest`** — parse a capability's
  `capability.json` and turn a connected provider into a grant.
- **Brokered egress client** — `egressFromEnv`, `brokeredGet`,
  `brokeredToken`, `brokeredProfile`, `brokeredCommons`, `brokeredCall`, used
  when running under the gateway.
- **`@dvd-toy-box/vault/kit`** — the higher-level helpers every capability ended up
  needing: the typed result envelope with credential redaction, and the
  standalone-or-brokered ladders for profile, commons data, and peer calls.

The contract a capability must satisfy (manifest schema, naming rules, run
modes, acceptance checklist) is [CAPABILITY.md](CAPABILITY.md). The tutorial
is [GUIDE.md](GUIDE.md). What is deliberately not in this package is
[FUTURE.md](FUTURE.md).

## Where things live

Default vault home, overridable with `VAULT_HOME`:

| Platform | Home | Secret backend |
| --- | --- | --- |
| macOS | `~/Library/Application Support/local-vault` | Keychain (service `com.local.vault`) |
| Linux | `$XDG_DATA_HOME/local-vault` or `~/.local/share/local-vault` | `secrets.json` |
| Windows | `%APPDATA%\local-vault` | `secrets.json` |

The directory is still named `local-vault`, and the Keychain service is still
`com.local.vault`, so installs made under the package's old name keep their
secrets. The home holds `connections.json` (provider, slot, status, scopes: no
secrets), `grants.json`, `profile.json`, and on the file backend
`secrets.json`. Force a backend with `VAULT_SECRETS_BACKEND=file` or
`keychain`.

## Grants

A grant is a row saying capability `weather` may use connection
`purpleair:default`, optionally restricted to named actions.

- **Auto** (`VAULT_GRANT_MODE=auto`, the default): the OS user may use any
  connection. `getSecretFor` succeeds without a row. This is the laptop
  setting: no extra permission prompt.
- **Explicit** (`VAULT_GRANT_MODE=explicit`): `getSecretFor` requires a
  matching grant. The gateway runs in this mode.

For credential connections an empty `actions` list means every action. For
`profile:*` and `capability:*` connections `actions` are the whole grant: an
empty list grants no profile fields and no peer tools.

Capability manifests live in each app, not here. Parse them with
`parseCapabilityManifest` and register a grant with `grantFromManifest` in
the same code path that stores the secret.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `VAULT_HOME` | Vault directory. |
| `VAULT_SECRETS_BACKEND` | `keychain` or `file`. Default: keychain on macOS, file elsewhere. |
| `VAULT_GRANT_MODE` | `auto` (default) or `explicit`. |
| `VAULT_SECRETS_ACCESS` | `broker` makes in-process secret and profile reads fail so a capability under the gateway cannot bypass brokered egress. |
| `VAULT_EGRESS_URL`, `VAULT_EGRESS_TOKEN` | Set by the gateway. Presence switches the kit helpers to brokered mode. |
| `COMMONS_DIR` | Standalone fallback directory for commons datasets. |

Environment variables and CLI flags are trusted configuration. Nothing here
defends against a caller that can already set them.

## Security model

**Secrets at rest.** On macOS, secrets go to the login Keychain via the
`security` CLI. Elsewhere they go to `secrets.json`, written atomically with
mode 0600 inside a 0700 directory. Connection, grant, and profile files never
contain secrets. Tool results built with the kit's `jsonResult` drop
credential-shaped keys and redact token-shaped strings.

**Grants.** Explicit mode is the enforcement mode. Auto mode deliberately
trusts every process running as the OS user; it is a convenience for a single
person's laptop, not a boundary.

**OAuth loopback.** `LoopbackServer` always requires an OAuth `state`. Pass
one, or read the minted `server.state` and put it in the authorize URL. A
callback that does not carry the exact value is answered 400 and does not
settle the flow, so a stranger, a stale tab, or a web page scanning loopback
ports cannot complete or abort a pending authorization.

**API-key page.** `ApiKeyLoopback` mints a state and puts it in the URL it
advertises. Only a request carrying that state is served the form; any other
request gets a form-less "expired" page. The posted key goes straight to the
vault and is never echoed.

**Not protected.** Another process running as the same OS user can read the
file backend, call the Keychain, or hit a loopback port. Binding a loopback to
`0.0.0.0` behind a reverse proxy is supported but makes the proxy part of the
trust boundary. There is no sandboxing of capabilities; under the gateway,
`VAULT_SECRETS_ACCESS=broker` is cooperative, not enforced by the OS.

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/toothbrush-inc/toy-box-vault/security/advisories/new)
rather than a public issue.

## Related repositories

- [capability-gateway](https://github.com/davidd8/capability-gateway) — one
  process mounting many capabilities: explicit grants, tool policy, audit log,
  brokered egress.
- [capability-template](https://github.com/davidd8/capability-template) — a
  working, conforming capability to start from.
- [weather-patterns](https://github.com/davidd8/weather-patterns) — API-key
  providers, hosted connect, profile-aware forecasts.
- [calsync](https://github.com/davidd8/calsync) — Google OAuth through the
  loopback server.

## Contributing

```sh
npm install
npm test
npm run typecheck
npm run build
```

Node 20 or newer. Tests use Vitest and run entirely offline; the loopback
tests bind ephemeral ports on 127.0.0.1. Keep the standalone case working:
a capability must not require the gateway.

## License

MIT. See [LICENSE](LICENSE).
