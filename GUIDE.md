# Writing an app for this platform — the simple path

This is the tutorial. [CAPABILITY.md](CAPABILITY.md) is the contract you'll
eventually conform to; read it after your first tool works, not before. The
worked example throughout is the
[fitness-tracker](https://github.com/davidd8/fitness-tracker) capability.

An app ("capability") here is just a **stdio MCP server that returns typed
JSON**, plus a small manifest. Everything else — credentials, user profile,
shared datasets, hosting — is opt-in, one layer at a time.

## Step 1 — three files

**`capability.json`** — your identity. Start with no connections at all:

```json
{ "id": "books", "connections": [] }
```

**`package.json`**:

```json
{
  "name": "books", "type": "module", "private": true,
  "scripts": { "mcp": "node mcp/server.mjs" },
  "dependencies": {
    "@local/vault": "github:davidd8/local-vault",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.4.3"
  }
}
```

**`mcp/server.mjs`** — one tool and a status:

```js
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCapabilityManifest } from "@local/vault";
import { z } from "zod";

parseCapabilityManifest(JSON.parse(readFileSync(new URL("../capability.json", import.meta.url), "utf8")));

const jsonResult = (payload) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(payload?.ok === false ? { isError: true } : {}),
});

const server = new McpServer({ name: "books", version: "0.1.0" });

server.registerTool("get_status",
  { description: "Works with nothing configured.", inputSchema: z.object({}) },
  () => jsonResult({ ok: true, data: { ready: true } }));

server.registerTool("log_book",
  { description: "Record a finished book.", inputSchema: z.object({ title: z.string() }) },
  ({ title }) => jsonResult({ ok: true, data: { logged: title } }));

await server.connect(new StdioServerTransport());
process.stderr.write("books mcp: listening on stdio\n");
```

Rules baked into those 30 lines: results are **typed JSON, never prose**;
`{ok, data}` on success, `{ok: false, error: {code, message}}` on failure;
logs go to **stderr** (stdout is the MCP wire); `get_status` works with
nothing configured.

## Step 2 — run it

```json
{ "mcpServers": { "books": { "command": "node", "args": ["mcp/server.mjs"], "cwd": "/path/to/books" } } }
```

That's a working, conforming capability. Everything below is optional.

## Step 3 — a private ledger (your app's own data)

Store your data in a JSON/SQLite file whose path comes from **your own env
var** (`BOOKS_DB`), defaulting to your working directory. Never touch another
capability's files — other apps reach your data only through your tools.
Declare it for visibility:

```json
"data": { "private": [{ "name": "books" }] }
```

(~20 lines: read array, append, atomic write via tmp+rename. Copy
`fitness-tracker/lib/db.mjs`.)

## Step 4 — profile awareness (the user's units, timezone, …)

Declare which profile fields you read, as `actions` on a `profile:default`
connection:

```json
"connections": [{ "provider": "profile", "slot": "default", "optional": true, "actions": ["timezone"] }]
```

Read with a fallback ladder — brokered under the gateway, direct standalone,
defaults when ungranted:

```js
import { brokeredProfile, egressFromEnv, openVault } from "@local/vault";

async function userTimezone() {
  try {
    const egress = egressFromEnv(process.env);
    const fields = egress
      ? await brokeredProfile(egress, { fields: ["timezone"] })
      : await openVault().getProfileFor("books", ["timezone"]);
    if (fields.timezone) return { timezone: fields.timezone, source: "profile" };
  } catch { /* ungranted or broker-only: fall through */ }
  return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, source: "default",
           note: "grant profile:default to books to personalize" };
}
```

**Never crash on a missing grant** — degrade with a note.

> **Honest note (→ improvement #2):** this ladder is copy-paste in every
> capability today. It should be one platform helper call.

## Step 5 — commons datasets (shared, non-personal reference data)

Declare (`"data": { "commons": [{ "dataset": "isbn-catalog" }] }`), then read
via `brokeredCommons(egress, {dataset})` under the gateway, a `COMMONS_DIR`
file standalone, and a bundled copy as last resort — and keep working when
all three fail. (Copy `fitness-tracker/lib/catalog.mjs`.)

> **Honest note (→ improvement #2):** same story — a three-branch ladder every
> capability re-implements.

## Step 6 — mount it in the gateway

One entry in `gateway.config.json`:

```json
{ "id": "books", "command": "node", "args": ["mcp/server.mjs"], "cwd": "/path/to/books",
  "manifestPath": "/path/to/books/capability.json", "env": { "BOOKS_DB": "/data/books/books.json" } }
```

Your tools appear to agents as `books__log_book`; every call is audited;
grants are enforced.

> **Honest note (→ improvement #4):** the gateway passes children only
> `VAULT_*` env vars, so every app env var must be repeated in this entry —
> the easiest thing on the whole platform to get wrong.
>
> **Honest note (→ improvement #3):** granting your app profile fields is
> currently a node one-liner against the vault, not a tool call.

## Step 7 — external APIs (only if you need credentials)

If your app calls a keyed API, this is where the contract earns its length:
manifest `egress` specs, `connect_provider`, `getSecretFor`/`brokeredGet`,
the three run modes. Read CAPABILITY.md §3–§6 and copy weather-compare's
`lib/provider-http.mjs`. Finish with the acceptance checklist (CAPABILITY.md,
bottom).

---

## Platform improvement backlog (from writing this guide)

Writing the simple path surfaced what is genuinely too complicated. In
priority order:

1. **A `create-capability` template/scaffold.** Steps 1–5 should be
   `npx create-capability books` producing the manifest, server skeleton,
   ledger, test harness (env fixtures, fake broker), and README. Today a
   full-featured capability is ~8 hand-copied files.
2. **Platform helpers for the ladders.** `jsonResult`/sanitize, a
   `profileContext(manifestId, fields, defaults)` helper, and a
   `commonsDataset(name, {bundledUrl})` helper — each implementing the
   standalone/brokered/broker-only ladder once — would delete ~150 lines of
   copy-paste per capability and make the three run modes invisible to
   authors. Natural home: a small `@local/capability-kit` package (keep the
   vault zero-magic).
3. **A `gateway_grant` meta tool.** Profile (and future data) grants need a
   conversational path — "grant fitness my units" — instead of a node
   one-liner. Deliberately deferred once already; the fitness build confirmed
   it is the roughest UX edge.
4. **Gateway-provisioned data dirs.** The manifest already declares private
   ledgers; the gateway could provision `<dataDir>/<id>/` and inject
   `<ID>_DB`-style env vars automatically, shrinking config entries to
   id+command+cwd+manifestPath and eliminating the env-repetition footgun.
5. **Keep this guide the entry point.** CAPABILITY.md has grown to nine
   normative sections; newcomers should meet the 30-line capability first and
   the contract second. (This document is that fix — keep it under two
   screens of code.)
6. **Standardize the result envelope in code, not convention.** The
   `{ok,data}` wrapper is convention across four repos; twice in testing the
   wire shape was mis-assumed. Helper #2 makes the convention executable.
