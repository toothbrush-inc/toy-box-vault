# Writing an app for this platform — the simple path

This is the tutorial. [CAPABILITY.md](CAPABILITY.md) is the contract you'll
eventually conform to; read it after your first tool works, not before. The
worked example throughout is the
[fitness-tracker](https://github.com/davidd8/fitness-tracker) capability.

An app ("capability") here is just a **stdio MCP server that returns typed
JSON**, plus a small manifest. Everything else — credentials, user profile,
shared datasets, hosting — is opt-in, one layer at a time.

## Step 0 — the fastest path

```sh
gh repo create yourname/books --template davidd8/capability-template --private --clone
cd books && npm install && npm test && npm run mcp
```

The [template](https://github.com/davidd8/capability-template) is a working,
conforming capability (typed results, private ledger, profile awareness,
tests). Rename `example` to your id and replace the tools. The rest of this
guide explains what each piece is.

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
import { jsonResult, ok } from "@local/vault/kit";
import { z } from "zod";

parseCapabilityManifest(JSON.parse(readFileSync(new URL("../capability.json", import.meta.url), "utf8")));

const server = new McpServer({ name: "books", version: "0.1.0" });

server.registerTool("get_status",
  { description: "Works with nothing configured.", inputSchema: z.object({}) },
  () => jsonResult(ok({ ready: true })));

server.registerTool("log_book",
  { description: "Record a finished book.", inputSchema: z.object({ title: z.string() }) },
  ({ title }) => jsonResult(ok({ logged: title })));

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

Read it with one kit call — the standalone/brokered/broker-only ladder is
built in, and it never throws:

```js
import { profileContext } from "@local/vault/kit";

const profile = await profileContext("books", ["timezone"], {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
// profile.values.timezone, profile.source ("profile"|"default"), profile.note?
```

When the field is ungranted you get your defaults plus an actionable note —
surface it in results; never crash. The user grants access conversationally:
*"grant books my timezone"* → the gateway's `gateway_grant` tool.

## Step 5 — commons datasets (shared, non-personal reference data)

Declare (`"data": { "commons": [{ "dataset": "isbn-catalog" }] }`), then one
kit call walks broker → `COMMONS_DIR` → your bundled copy and never throws:

```js
import { commonsDataset } from "@local/vault/kit";

const catalog = await commonsDataset("isbn-catalog", {
  bundled: () => JSON.parse(readFileSync(new URL("../data/isbn-catalog.json", import.meta.url), "utf8")),
});
// catalog.data, catalog.source ("broker"|"dir"|"bundled"|"none")
```

Keep working when `source` is `"none"`.

## Step 6 — mount it in the gateway

One entry in `gateway.config.json`:

```json
{ "id": "books", "command": "node", "args": ["mcp/server.mjs"], "cwd": "/path/to/books",
  "manifestPath": "/path/to/books/capability.json" }
```

Your tools appear to agents as `books__log_book`; every call is audited;
grants are enforced. Declare each ledger's `env` in the manifest
(`"data": { "private": [{ "name": "books", "env": "BOOKS_DB" }] }`) and a
gateway with `dataDir` configured provisions `<dataDir>/books/` and injects
`BOOKS_DB` automatically — no env repetition in the config (an explicit
`spec.env` still wins when you need it).

## Step 7 — external APIs (only if you need credentials)

If your app calls a keyed API, this is where the contract earns its length:
manifest `egress` specs, `connect_provider`, `getSecretFor`/`brokeredGet`,
the three run modes. Read CAPABILITY.md §3–§6 and copy weather-compare's
`lib/provider-http.mjs`. Finish with the acceptance checklist (CAPABILITY.md,
bottom).

---

## Platform improvement backlog (from writing this guide)

Writing the simple path surfaced what was genuinely too complicated. Status:

1. **Template/scaffold** — ✅ shipped:
   [`capability-template`](https://github.com/davidd8/capability-template)
   (GitHub template repo; `gh repo create --template`). A working conforming
   capability out of the box.
2. **Platform helpers for the ladders** — ✅ shipped as the
   **`@local/vault/kit`** subpath: `jsonResult`/`ok`/`fail` (sanitizing
   result envelope), `profileContext`, `commonsDataset`. Adopting the kit
   removed ~120 lines from fitness-tracker with zero behavior change; the
   three run modes are now invisible to authors.
3. **`gateway_grant` meta tool** — ✅ shipped (plus `gateway_revoke_grant`):
   grants are a conversation, actions default to the manifest's declaration.
4. **Gateway-provisioned data dirs** — ✅ shipped: manifests declare each
   ledger's `env`/`file`; a gateway `dataDir` provisions and injects paths.
5. **Keep this guide the entry point** — ongoing discipline: the contract
   grows, this document stays under two screens of code.

Remaining candidate (not yet needed twice, so not built): a kit helper for
the **credentialed provider-fetch ladder** (weather's `providerGetJSON`) —
extract it when a second capability needs keyed HTTP APIs.
