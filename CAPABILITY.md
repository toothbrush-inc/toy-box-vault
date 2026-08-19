# The capability contract

What a new repo must implement to plug into the local capability platform.

A **capability** is a standalone app that connects to external services through
the shared vault, declares which connections it needs, and exposes its features
as a local stdio MCP server with typed results. Connections are the platform's
system accounts (`google:personal`, `purpleair:default`); grants are per-app
permissions ("weather may use `purpleair:default`"); the vault stores both. The
agent surface (Claude, Cursor, …) is the shell.

The two reference capabilities implement everything below: **calsync**
(`apps/cli/capability.json`, `apps/cli/src/capability.ts`,
`apps/cli/src/storage/tokens.ts`) and **weather-compare** (`capability.json`,
`lib/vault.mjs`, `mcp/connect.mjs`). When in doubt, copy them.

## 1. Manifest

Ship a `capability.json` at your package root and parse it at startup with
`parseCapabilityManifest`, so schema drift fails fast instead of at first use:

```json
{
  "id": "weather",
  "connections": [
    { "provider": "purpleair", "slot": "default", "optional": true, "actions": ["read"] },
    { "provider": "open_meteo", "slot": "default", "optional": true }
  ]
}
```

- `id` — the capability's name; a token (see naming rules).
- `connections[]` — every external connection the capability may use:
  - `provider` (required token) and `slot` (required token). Use slots to
    distinguish accounts of the same provider (`personal` / `work`); use
    `default` when there is only one.
  - `optional` (required boolean) — `true` when the capability degrades
    gracefully without the connection.
  - `actions` (optional string array) — the verbs this capability needs, e.g.
    `["read"]` or `["read", "write"]`. Omit for "all actions". Keep the
    vocabulary plain; per-endpoint enforcement is the future broker's job.

`parseCapabilityManifest` trims and lowercases `id`, `provider`, and `slot`,
and rejects anything malformed with an indexed error message.

```js
import { readFileSync } from "node:fs";
import { parseCapabilityManifest } from "@local/vault";

export const MANIFEST = parseCapabilityManifest(
  JSON.parse(readFileSync(new URL("../capability.json", import.meta.url), "utf8")),
);
```

## 2. Naming rules

- Tokens (`id`, `provider`, `slot`, action strings): `/^[a-z][a-z0-9_-]*$/i`,
  stored lowercase.
- `connectionId(provider, slot)` → `provider:slot` (e.g. `google:personal`).
- `grantId(capability, connectionId)` → `capability:provider:slot`
  (e.g. `weather:purpleair:default`).

Always build ids with `connectionId()` / `grantId()`; never concatenate by hand.

## 3. Vault usage

Depend on `@local/vault` via `package.json` (`npm install
github:davidd8/local-vault`), never a relative sibling path. Call `openVault()`
with no arguments so `VAULT_HOME` and `VAULT_SECRETS_BACKEND` keep working.

**Connect** — the browser gets the secret; tools and chat never do:

- OAuth providers: run the auth-code flow against a `LoopbackServer` redirect
  (calsync `apps/cli/src/google/auth.ts`).
- API-key providers: serve an `ApiKeyLoopback` form and return its `url` from
  your `connect_provider` tool (weather `mcp/connect.mjs`).
- On completion, in the same code path: `putSecret({provider, slot, kind,
  secret})` **then** `putGrant(grantFromManifest(MANIFEST, provider, slot))`.
  Keep a single write path so every connect route registers the grant
  identically. `putGrant` does not require the connection row to exist yet;
  grant rows are inert until `getSecretFor` consults them.

**Fetch** — every code path that uses a secret to call an external API reads it
with `getSecretFor(MANIFEST.id, connectionId, action?)`. Pass an action when
the path has one clear intent (`"read"` for a data fetch); omit it when the
secret is a bearer of several (an OAuth refresh token used for read and write).
Status displays and CLI listings may use `getSecret` / `status` (masked).

**Disconnect** — `revoke(connectionId)` removes the secret, the connection row,
and (cascading) every capability's grant rows for it. `revokeGrant(capability,
connectionId)` removes only your own permission and leaves the connection for
other capabilities.

## 4. Grant modes

The vault runs in one of two modes (`VAULT_GRANT_MODE`):

- `auto` (default) — the OS user may use any connection; `getSecretFor`
  succeeds without a row. This is the laptop path: zero extra prompts.
- `explicit` — `getSecretFor` throws `GrantError` unless a matching grant row
  exists (and, when an action is passed, the row's `actions` include it or are
  empty). Use it to test hosted-like semantics locally.

A conforming capability must:

- register grants at connect time even though `auto` never checks them — the
  grants table must be truthful before `explicit` is ever enabled;
- catch `GrantError` on fetch paths and fail **actionably** — name the missing
  grant and the exact command or tool call that repairs it ("run `calsync auth
  personal`", "call `connect_provider` with `provider=purpleair`") — never a
  stack trace;
- treat a *missing* secret as the ordinary not-connected case, not a grant
  failure.

## 5. MCP conventions

Expose the capability as a **stdio** MCP server (`@modelcontextprotocol/sdk`):

- Tool results are typed JSON, never prose: `{ok: true, data}` on success,
  `{ok: false, error: {code, message}}` on failure — emitted as both JSON text
  content and `structuredContent`.
- Sanitize every payload: no secrets, tokens, or key-bearing URLs in results;
  masked status only (`maskSecret`). Grep your test output for a planted secret
  to prove it.
- Provide `get_status` (connection + grant state, masked) and
  `connect_provider` (returns `{url, expires_at}`; **never accepts a secret as
  an argument**).
- Optional but encouraged: a `request_capability` gap tool that records what
  users asked for and couldn't have (weather `lib/gaps.mjs`).

## 6. Brokered egress

When a capability runs under a gateway/broker, credentialed requests can be
routed through it so the capability never touches the raw secret. The contract:

**Manifest**: a connection that needs credentialed egress declares it:

```json
"egress": {
  "hosts": ["api.purpleair.com"],
  "attach": { "kind": "header", "name": "X-API-Key" },
  "hostRewrite": { "api.open-meteo.com": "customer-api.open-meteo.com" }
}
```

- `hosts` — bare hostnames the capability may *request* (public hosts; no
  scheme, port, or path). Allowlisting is host-level because some APIs (NWS)
  return follow-up URLs in response bodies.
- `attach` — how the broker adds the credential: a `header` or a `query`
  parameter with the given name.
- `hostRewrite` (optional) — public→keyed host map the broker applies only
  when a credential exists (the Open-Meteo customer-host pattern). The
  capability always builds and persists PUBLIC urls.

**Environment**: the broker hands children `VAULT_EGRESS_URL` and
`VAULT_EGRESS_TOKEN`. Read them with `egressFromEnv(env)`; when present, route
credentialed fetches with `brokeredGet(egress, {provider, slot, url,
headers})`. It returns `{status, contentType, body}` — upstream non-2xx comes
back as data — and throws only for broker-level failures, always with a
`.code`: `egress_unauthorized`, `egress_bad_request`, `egress_denied`
(undeclared provider), `grant_missing`, `egress_host_denied`,
`egress_method_not_allowed`, `upstream_unreachable`, `egress_unreachable`,
`egress_error`. The client is generic: the capability owns JSON parsing and
its own error wording (map `grant_missing` to your reconnect hint).

**Broker-only mode**: `VAULT_SECRETS_ACCESS=broker` (set by the gateway, not
by capabilities) makes `getSecretFor` throw `EgressRequiredError` so a fetch
path that bypasses the broker fails loudly. `getSecret`/`status` (masked
display, presence checks) keep working. This is cooperative on one machine —
the hosted platform enforces the same rule with sandboxing — so a conforming
capability must work in all three modes: standalone (no egress env, reads via
`getSecretFor`), brokered (egress env present, fetches via `brokeredGet`), and
broker-only (both).

## 7. Standalone rule

A capability must run with only `@local/vault` and its own repo — no gateway,
no sibling capability, no platform service. The broker that enforces grants on
every call and attaches secrets only to allowlisted hosts is a later, separate
package ([FUTURE.md](FUTURE.md)); until it exists, fetchers read the secret
in-process after `getSecretFor`.

## Acceptance checklist

A new capability conforms when all of these hold:

- [ ] `capability.json` at the package root parses with
      `parseCapabilityManifest` at startup.
- [ ] All external-service use is declared in the manifest; provider/slot/action
      names follow the naming rules.
- [ ] Connecting a provider writes the secret via `putSecret` and registers a
      grant via `putGrant(grantFromManifest(...))` in the same code path;
      `grants.json` shows the row immediately, even in `auto` mode.
- [ ] Every fetch path reads secrets with `getSecretFor`; only status/CLI
      display uses `getSecret` / `status`.
- [ ] Under `VAULT_GRANT_MODE=explicit`, a present-but-ungranted secret fails
      with an actionable message naming the repair command; a missing secret
      still behaves as plain not-connected.
- [ ] Disconnecting removes the grant rows (via `revoke`'s cascade or
      `revokeGrant`).
- [ ] Tools are stdio MCP with `{ok, data}` / `{ok: false, error}` typed
      results; `get_status` and `connect_provider` exist; `connect_provider`
      returns a URL and never accepts a secret.
- [ ] No secret ever appears in a tool result, log line, or error message
      (masked values only) — asserted by a test.
- [ ] The repo runs standalone: fresh clone, `npm install`, works with no other
      capability or gateway checked out.
- [ ] Optional connections stay optional: the capability starts and reports
      status with zero connections configured.

Everything referenced here is exported from the `@local/vault` barrel:
`openVault`, `connectionId`, `grantId`, `maskSecret`, `parseCapabilityManifest`,
`grantFromManifest`, `LoopbackServer`, `ApiKeyLoopback`, `GrantError`, and the
types (`CapabilityManifest`, `ManifestConnectionNeed`, `PutGrantInput`,
`GrantRecord`, `ConnectionView`).
