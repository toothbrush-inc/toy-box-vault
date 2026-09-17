# The capability contract

What a new repo must implement to plug into the local capability platform.
New here? Start with the tutorial — [GUIDE.md](GUIDE.md) — and return to this
contract as the reference.

A **capability** is a standalone app that connects to external services through
the shared toy-box vault, declares which connections it needs, and exposes its features
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

- `store` (optional object) — the words a storefront uses for this app: the
  gateway's public `/` page, its `gateway_status` output, and any agent index.
  The app owns these words; a deployment may override any field in its own
  config. `name` is required; everything else is optional.

  ```json
  "store": {
    "name": "Weather",
    "tagline": "Know which forecast to trust before you plan the day.",
    "description": "Three forecasts side by side for the places you follow, with a running score of who was right.",
    "highlights": ["Today's high and low", "Air quality from a sensor near you"],
    "badge": "beta",
    "accent": "sky",
    "web": { "path": "/weather" },
    "repo": "https://github.com/davidd8/weather-patterns"
  }
  ```

  - `name` (≤60) — what people call the app; the tile label.
  - `tagline` (≤120) — one line under the name: what it does for you.
  - `description` (≤600) — a short paragraph on why it is valuable.
  - `highlights` (≤4 lines, ≤120 each) — concrete reasons, one per line.
  - `badge` (≤20) — a status word such as `beta` or `new`.
  - `accent` — one of `sky`, `leaf`, `marigold`, `plum`, `clay`, `slate`.
  - `web.path` — an absolute path where the app's own web UI mounts under a
    store domain. Omit for an agent-only capability (tools, no page).
  - `repo` — the open-source repository, so a reader can run it themselves.

  Use the same `name` and `tagline` at the top of the README, so the repo,
  the store tile, and the assistant's index all say the same thing.

`parseCapabilityManifest` trims and lowercases `id`, `provider`, and `slot`,
and rejects anything malformed with an indexed error message.

```js
import { readFileSync } from "node:fs";
import { parseCapabilityManifest } from "@dvd-toy-box/vault";

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

Verified identities (signed-in emails) share one opaque id across the
platform: `tenantForIdentity(email)` / `identitySlug(email)` →
`i` + the first 32 hex characters of SHA-256 of the lowercased address.
calsync uses that as the auto tenant id (and thus broker slot prefix);
the gateway uses it as the per-user profile directory. Do not invent a
parallel punctuation slug in an app. Prefer `tenantForIdentity` when
email→tenant overrides are needed; use `identitySlug` when bare owners
(no `@`) must also resolve.

## 3. Vault usage

Depend on `@dvd-toy-box/vault` via `package.json` (`npm install
@dvd-toy-box/vault`, or `github:toothbrush-inc/toy-box-vault#<sha>` to track
an unreleased commit), never a relative sibling path. Call `openVault()`
with no arguments so `VAULT_HOME` and `VAULT_SECRETS_BACKEND` keep working.

**Connect** — the browser gets the secret; tools and chat never do:

- OAuth providers: run the auth-code flow against a `LoopbackServer` redirect
  (calsync `apps/cli/src/google/auth.ts`). Put `server.state` in the authorize
  URL: the callback only settles when it comes back with that exact value.
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
- Provide `get_status` (connection + grant state, masked; must work with
  nothing configured). Capabilities with credentialed connections also provide
  `connect_provider` (returns `{url, expires_at}`; **never accepts a secret as
  an argument**) — a pure-ledger capability with no credentialed connections
  needs no connect flow at all.
- Optional but encouraged: a `request_capability` gap tool that records what
  users asked for and couldn't have (weather `lib/gaps.mjs`).
- **Wrap the server in `withCallScope`** (from `@dvd-toy-box/vault/kit`) before
  registering tools:

  ```js
  const server = withCallScope(new McpServer({ name, version }));
  ```

  Under a gateway one process serves every user, and the caller travels as an
  opaque nonce in each call's `_meta`. The wrapper puts it in ambient context
  so `profileContext` and the brokered helpers resolve the right user with no
  per-tool wiring. Standalone there is no `_meta` and handlers run unwrapped,
  so behaviour on your own is unchanged (§7). You never see a user identity —
  only the broker can resolve the nonce, so a capability cannot name a user it
  was not handed.

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

**Keyless-by-default providers.** Some APIs work without a credential
(Open-Meteo's public tier). Brokered egress is still grant-gated — the grant
authorizes the outbound call, not just the key — so the repair for a denied
fetch differs by provider kind, and your error messages must say the right
thing: for a keyless provider point at the *grant* ("grant
`<provider>:<slot>` — no key needed", e.g. the gateway's `gateway_grant`),
never at the key form. Connect flows for keyless providers must complete on
an empty submission (`ApiKeyLoopbackPage.allowEmpty`) by writing the grant
without storing a secret; the key form is only for optional paid tiers.

## 7. Standalone rule

A capability must run with only `@dvd-toy-box/vault` and its own repo — no gateway,
no sibling capability, no platform service. The
[capability gateway](https://github.com/toothbrush-inc/toy-box-gateway) is strictly
additive: it composes capabilities, enforces grants and egress, and audits —
but a capability that *requires* it does not conform.

## 8. Delivering and deploying a capability

What an app developer ships, and how users run it.

### The deliverable

- **One repo, npm-installable.** `npm install github:you/your-capability` must
  produce a runnable package (use a `prepare` script if you build TypeScript).
  Depend on `@dvd-toy-box/vault` via `package.json` — never a relative sibling path.
- **`capability.json` at the package root** (§1), including `egress` specs
  (§6) for every credentialed provider.
- **A stdio MCP entrypoint** — a `bin` or a documented
  `node <path>` command. stdout is the MCP wire; all diagnostics go to stderr.
  This entrypoint is the unit both Claude/Cursor configs and the gateway spawn.
- **A README** that opens the way the store tile does and then tells a
  reader how to run it. In order: the `store.name` and `store.tagline` as the
  title; a "Two ways to use it" section (hosted at the store vs. run it
  yourself); how it works; what you get; quick start; "Use it from your
  assistant" with the MCP client config and a table of tools (name, what it
  does, reads/writes); privacy and data (what is stored, where, what leaves
  the machine); and a "For developers" section holding which connections the
  capability needs and how a user obtains keys/accounts, the
  `connect_provider` flow, any background jobs (schedulers, launchd) and how
  to install them, and the two deployment shapes below. Contract detail
  (run modes, data classes, section references) belongs under "For
  developers", not above it.

### The three run modes (all mandatory)

| Mode | Trigger | Secret access |
|---|---|---|
| Standalone | no egress env | `getSecretFor` in-process; local attach per manifest |
| Brokered | `VAULT_EGRESS_URL`/`VAULT_EGRESS_TOKEN` present | `brokeredGet` / `brokeredToken`; no key in-process |
| Broker-only | + `VAULT_SECRETS_ACCESS=broker` | fetch-path reads throw; broker is the only path |

Route every credentialed request through **one choke-point helper** that picks
the mode (weather-compare's `lib/provider-http.mjs` and calsync's
`TokenExchange` wiring are the reference implementations). Presence checks use
`status()`-based helpers, never fetch-path reads. Never require users to set
any `VAULT_*` variable by hand — the platform injects them.

The same three modes govern **profile and commons** access (§9): standalone
uses `getProfileFor` / a local dataset fallback; brokered uses
`brokeredProfile` / `brokeredCommons`; broker-only blocks direct profile
fetch-path reads exactly like secrets.

### How users deploy it

**Standalone** (an MCP client config):

```json
{ "mcpServers": { "yourapp": { "command": "node", "args": ["mcp/server.mjs"], "cwd": "/path/to/yourapp" } } }
```

**Under the gateway** (recommended; one entry in `gateway.config.json`):

```json
{
  "id": "yourapp",
  "command": "node",
  "args": ["mcp/server.mjs"],
  "cwd": "/path/to/yourapp",
  "manifestPath": "/path/to/yourapp/capability.json",
  "secretsAccess": "broker"
}
```

Declare `secretsAccess: "broker"` once your fetch paths are broker-clean. If
the capability uses an OAuth provider, document what the gateway's `oauth`
block needs (e.g. which env file holds the client id/secret). Tool names are
the agent-facing API and arrive prefixed (`yourapp__<tool>`).

### Compatibility expectations

- The capability `id` is forever: grants and audit history are keyed by it.
- Tool names and result shapes are the public API — additive changes only.
- Track `@dvd-toy-box/vault` minor versions; the barrel at the bottom of this doc is
  the full API you may rely on.

## 9. Data classes

Every piece of data a capability touches falls into one of three classes.

**Private data — the capability's own ledgers.** Reading lists, sync mappings,
collected history. Stored in files the capability names via its **own** env
vars (convention: `<ID>_DB`, e.g. `BOOKS_DB`, `WEATHER_DB`), defaulting to
its working directory. Never read or write another capability's files — other
capabilities (and the agent) reach this data only through your tools; the
agent is the join layer across capabilities. Declare ledgers in the manifest's
optional `data.private` block (`[{ "name": "books", "description": "…" }]`)
— visibility metadata surfaced by the platform, not an access mechanism.

**User/profile data — tiny shared facts, grant-gated per field.** The platform
keeps one small profile (`profile.json` in the vault home): stable facts many
capabilities need. Canonical fields: `units` (`imperial`|`metric`), `timezone`
(IANA name), `home_lat`/`home_lon`, `birthday` (ISO date), `locale`. Hard
bounds enforced in code: **32 fields, values ≤ 256 chars, ≤ 16 KB total** — it
must not grow into a data lake. To use it, declare a **profile connection**:

```json
{ "provider": "profile", "slot": "default", "optional": true, "actions": ["units", "timezone"] }
```

`actions` are the FIELD names — and for profile connections they are
**mandatory**: an omitted `actions` array declares no fields (unlike
credential connections, where it means "all actions"). Reads: standalone →
`getProfileFor(MANIFEST.id, ["units","timezone"])`; under a gateway →
`brokeredProfile(egress, {fields})`. A granted-but-unset field is simply
omitted — apply your defaults. An ungranted field fails with a coded
`grant_missing`/`GrantError`; a conforming capability **degrades gracefully**
(defaults plus an actionable note), never crashes. Never attach an `egress`
spec to a profile connection. Profile values are not secrets (plain display in
tool results is fine) — but they must never appear in logs or audit output;
audit rows carry field names only. Profile data always survives grant
revocation: access dies, data stays.

**Never cache per-user data in module scope.** One process serves every user,
so a module-level `let units` or a memoised location outlives the call that set
it and will serve one user's value to the next — silently, with nothing in the
logs. Read per-user values per call (the context is ambient, so this is cheap),
or key any cache by something the call provides. Caching *non*-personal data —
a commons dataset, a geocoding result — is fine.

**Commons data — public, platform-owned, read-only.** Non-personal shared
datasets (an exercise catalog; hosted later, deduped weather readings).
Declare what you consult in `data.commons`
(`[{ "dataset": "exercise-catalog" }]`). Reads: under a gateway →
`brokeredCommons(egress, {dataset, key?})` (audited; the dataset must be
declared); standalone → a documented local fallback (a `COMMONS_DIR` env
and/or a bundled copy). No grants — commons is public-read by definition — and
the capability must keep working when the dataset is unavailable.

## 10. Peer capability calls

A capability may consume **another capability's data** — but only through the
producer's tools, only under the gateway, and only with a grant. Declare the
peer as a pseudo-connection whose `actions` enumerate the producer **tools**
you may invoke:

```json
{ "provider": "capability", "slot": "weather", "optional": true, "actions": ["get_forecast"] }
```

Like profile connections, `actions` are **mandatory** — an omitted array
declares no tools — and an `egress` spec is never attached. Call with the kit:

```js
import { peerCall } from "@dvd-toy-box/vault/kit";

const forecast = await peerCall("weather", "get_forecast", { days: 7 });
// forecast.ok, forecast.data (the producer envelope's data), forecast.error?, forecast.note?
// forecast.provenance? — {capability, version, ts}, stamped by the broker
```

Producers opt into being consumed by annotating their **query tools** — the
side-effect-free tools safe to call on a read/refresh path:

```json
"tools": { "query": ["get_reading_stats", "get_recent_books", "get_status"] }
```

Pinned views bind *only* query tools (a glance must never fire a mutation),
and grant defaults may use the list. A tool that writes, sends, or deletes
must never be annotated as a query tool.

`peerCall` never throws. Standalone there is no peer process to reach, so it
returns `{ok: false, error: {code: "peer_unavailable"}}` — degrade gracefully,
exactly as with an ungranted profile field. Under the gateway the broker
verifies the declaration, checks the per-tool grant (users grant
conversationally: *"grant books access to the weather forecast"* → `gateway_grant`),
enforces the producer-side tool policy, routes to the mounted producer child,
audits `call:<producer>__<tool>` with both capabilities' versions (never args
or results), and stamps provenance. Self-calls are denied; a peer that isn't
mounted fails with `call_not_mounted` — handle both as unavailability, not as
errors to retry.

## Acceptance checklist

A new capability conforms when all of these hold:

- [ ] `capability.json` at the package root parses with
      `parseCapabilityManifest` at startup.
- [ ] The manifest's `store` block names the app, and the README's title and
      tagline use the same words.
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
- [ ] All three run modes work (§8): standalone, brokered (egress env), and
      broker-only (`VAULT_SECRETS_ACCESS=broker`) — asserted by tests using a
      fake broker; under broker-only, no fetch path reads a secret.
- [ ] Delivery: `npm install github:you/your-capability` yields a runnable
      stdio MCP entrypoint, and the README documents connections, tools,
      background jobs, and both deployment shapes.
- [ ] Every profile field read is declared as an action on the capability's
      `profile:default` connection; under `VAULT_GRANT_MODE=explicit` an
      ungranted field degrades gracefully with an actionable note, never a
      crash.
- [ ] Private ledgers are declared in `data.private`, their paths come from
      the capability's own env vars, and no code path touches another
      capability's data files.
- [ ] Commons datasets consulted are declared in `data.commons`, and the
      capability works when a dataset is unavailable.
- [ ] Profile values never appear in logs or audit output — asserted by a
      test. Tool results may display them.
- [ ] Every peer tool invoked is declared as an action on a
      `capability:<producer>` connection; peer unavailability (standalone,
      ungranted, producer unmounted) degrades gracefully, never a crash.

Everything referenced here is exported from the `@dvd-toy-box/vault` barrel:
`openVault`, `connectionId`, `grantId`, `maskSecret`, `tenantForIdentity`,
`identitySlug`, `parseCapabilityManifest`,
`grantFromManifest`, `LoopbackServer`, `ApiKeyLoopback`, `egressFromEnv`,
`brokeredGet`, `brokeredToken`, `brokeredProfile`, `brokeredCommons`,
`brokeredCall`, `capabilityConnectionId`, `CAPABILITY_PROVIDER`,
`GrantError`, `EgressRequiredError`, `ProfileBoundsError`, the `PROFILE_*`
constants, and the types (`CapabilityManifest`, `ManifestConnectionNeed`,
`ManifestEgressSpec`, `ManifestData`, `PutGrantInput`, `GrantRecord`,
`ConnectionView`, `EgressEndpoint`, `BrokeredResponse`, `BrokeredToken`,
`BrokeredCallResult`, `PeerProvenance`, `SecretsAccess`, `ProfileStore`).
