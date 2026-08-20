# Future packages (not this slice)

Slice 5 is the grants **table** and per-app capability **manifests**. These packages
are deliberately not started here. Keep them out of `@local/vault` until there is a
real broker or a hosted store.

## Gateway / broker package

A grant row is a record: “weather may use `purpleair:default`.” A **broker** is the
software that enforces that row on every call.

Not in this repo yet:

- One process that mounts several capability MCP servers (optional locally; hosted default)
- Attach the secret only to allowlisted hosts (`api.purpleair.com`, Google APIs)
- The capability never sees the raw secret
- Audit log, rate limits, revoke one app without wiping the connection
- Install / grant UI (hosted identity + permission screen)

The broker now exists at
[davidd8/capability-gateway](https://github.com/davidd8/capability-gateway):
one process mounting capability MCP servers with explicit-mode grants, tool
policy, an audit log, and **brokered egress** — API keys attached only to
manifest-allowlisted hosts (weather is fully migrated and never touches its
keys under the gateway), plus Google OAuth token exchange (the broker holds
the refresh token; capabilities get short-lived access tokens). Still future:
calsync's internal adoption of `/token` (a BrokeredAuthClient for googleapis —
until then calsync reads its refresh token in-process under explicit grants),
rate limits, and OS sandboxing (local enforcement is cooperative via
`VAULT_SECRETS_ACCESS=broker`). Local default remains `VAULT_GRANT_MODE=auto`
(OS user, no extra prompt). Standalone stdio MCP stays the OSS unit; weather
must not require CalSync or a gateway.

## Hosted data-store package

The LOCAL semantics for all three classes now exist: private ledgers are a
contract (CAPABILITY.md §9, per-capability `<ID>_DB` files, tools-only
access), the user profile is a bounded grant-gated store in this package
(`profile.json`, per-field grants riding `profile:default`), and commons is a
gateway-served read-only dataset directory. What remains hosted is the sync
machinery below.

Hosted persistence is a separate package from the vault (connections + grants) and
from each capability’s local ledger. One store, three classes of data:

1. **Public data** (commons) — shared datasets anyone may read, nothing personal.
   Example: weather readings keyed by location, not by account. Users hold pointers
   (which location they follow); the commons holds no PurpleAir keys or names.
2. **User data** — facts and config that belong to a logged-in person and may be
   grant-gated across capabilities. Example: home/work location, timezone, which
   PurpleAir sensor they chose. Keep this small; it must not grow into a data lake.
3. **Private data** — capability-owned ledgers that do not cross the grant broker
   by default. Example: CalSync mappings, exclusions, busy windows; weather history
   that stayed on one laptop. Hosted copies stay encrypted per user; other
   capabilities see them only through tools (or later, explicit data grants).

Local OSS keeps writing JSON/SQLite in each app. The hosted store is the swap
point for those adapters — same tools, different backing files. Do not fold this
into `@local/vault`; the vault is credentials, not datasets.

## Small refactors on hold

`connections.ts` and `grants.ts` duplicate their JSON read/write/delete bodies
on purpose. Extract a generic JSON record store only if a third file store
appears.
