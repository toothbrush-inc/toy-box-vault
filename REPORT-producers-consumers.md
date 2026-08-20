# Producers and consumers: how easy is each role today?

*2026-08-20 — assessment of the capability platform through the producer/consumer lens.*

**The lens.** Producers add data to the system; consumers read it. Today's consumer
is the agent over MCP; next is views; the end state includes apps that do both
(fitness-tracker is the prototype).

**TL;DR.** Producing your *own* data is a solved problem — minutes of work.
Consuming the *platform's* stores (profile, commons) is one kit call. But the only
consumer that can reach a *producer's* data is the agent: there is no app-to-app
data path, no app write path into commons, and views (when built) will need a read
surface that doesn't exist yet. The good news: everything is already tool-shaped
with typed results and a proven grant machine, so this is a routing gap, not a
data-model gap. One mechanism — broker-routed, grant-gated tool calls — closes
most of it.

## Report card

| Role | Path today | Effort | Grade |
|---|---|---|---|
| Produce own data (private ledger) | template + `env` in manifest; gateway `dataDir` provisions the path | minutes | **A** |
| Expose that data to consumers | your MCP tools, typed `{ok, data}` envelope | free (it's your app) | **A−** |
| Consume profile from an app | `profileContext()` — one call, never throws, graceful when ungranted | one line | **A** |
| Consume commons from an app | `commonsDataset()` — broker → dir → bundled ladder | one line | **A** |
| Agent consumes any app | gateway-prefixed tools, grants enforced, every call audited | config entry | **A** |
| App consumes a *peer app's* data | none — the agent is the only join layer | impossible | **F** |
| App *produces into* commons | none — commons is operator-seeded, read-only | impossible | **F** |
| Views consume anything | designed (refresh-on-read via tool calls), not built | n/a | **incomplete** |

## Why the two F's are one problem

Fitness-tracker "produces and consumes" only because everything it consumes is
platform-owned (profile, commons). A meal-planner that wants workout data, or a
views card showing this week's streak, has no path: the broker's four routes
(`/fetch`, `/token`, `/profile`, `/commons`) are all credential exchanges or
platform-store reads. Producers already publish a perfectly good machine-readable
surface — their tools — but nothing except the agent can call it.

## Recommendations

1. **Producer-as-provider grants + a broker `/call` route.** Repeat the trick that
   made profile nearly free: a consumer declares
   `{"provider": "capability", "slot": "fitness", "actions": ["get_workout_stats"]}`;
   the broker routes the call to the mounted producer child, per-tool grant checks
   and audit riding the existing machinery unchanged. This single mechanism turns
   the app-to-app **F** into an A *and* is exactly the read surface the views
   design needs — build it once, both consumers arrive.
2. **A commons publish path.** Manifest commons entries gain `"publish": true`;
   broker accepts size-bounded, audited writes to declared datasets. Commons goes
   from operator-seeded to app-producible (e.g. fitness publishing an anonymized
   exercise-popularity dataset).
3. **Mark read-only "query tools" in the manifest.** A one-word annotation lets
   the gateway default `/call` grants (and future view bindings) to the safe
   subset, keeping "grant meal-planner my workouts" a one-liner instead of a
   tool-by-tool negotiation.

## Provenance: who made this data, which version, when?

What `/call` gives us for free, and what needs one addition:

- **When — free today.** Every audit entry carries `ts`, and data *creation* is
  already time-audited: a workout only exists because `fitness__log_workout` ran,
  and that call is in the JSONL with timestamp, session, client, and user.
- **Which app — free with `/call`, and richer.** The broker's bearer token
  identifies the caller, so a `/call` row names *both* sides: consumer capability
  → producer capability + tool. Today's entries have one `capability` column
  because the agent is the only caller.
- **Which version — needs one addition.** No version exists anywhere: not in the
  manifest, not read from `package.json`, not in audit. Fix: the gateway reads
  each capability's `package.json` version at mount (nothing new to keep in
  sync) and stamps `capability_version` into status and audit entries — cheap,
  known once per mount.

Two design commitments that follow:

- **Self-reported locally, attested hosted.** A `package.json` version is what
  the app claims — fine for the local cooperative boundary. Hosted, the deploy
  already pins image digests; binding `capability@version → digest` in the
  deploy manifest makes the audit's version column trustworthy.
- **Audit ≠ data provenance.** The audit records *events*; stamping the data is
  separate. Private-ledger records stay the producer's job (a kit helper can
  standardize `{created_at, created_by: "fitness@1.2.0"}`). On the commons
  publish path the **broker**, not the app, must wrap published datasets in
  `{publishedBy, version, ts}` so shared-data provenance can't be forged.

**Sequencing.** Recommendation 1 (with version capture) before views — the views
slice gets dramatically simpler if cards read through `/call` instead of growing
a bespoke data plane. Recommendations 2–3 are severable and small.

> **Update (2026-08-20):** Recommendation 1 shipped, with version capture —
> vault v0.8.0 (`brokeredCall`, kit `peerCall`, CAPABILITY.md §10) and gateway
> v0.6.0 (`POST /call`, mount-time versions in status and audit, provenance
> stamping). E2E-proven: a consumer app read fitness stats through the broker
> with grants, mid-session revocation, and value-free versioned audit rows.
> Recommendation 2 (commons publish) remains open.
>
> **Update (2026-08-20, later):** Recommendation 3 shipped as manifest
> `tools.query` (vault v0.9.0), and the **views system is built** on top of
> `/call` (gateway v0.7.0): pinned compiled cards that read through the
> peer-call machinery as grant-consumer `view-<id>`, bind only annotated
> query tools, and carry per-query provenance. The "views: incomplete" row
> above is now an **A** on the same mechanism as app consumers.
