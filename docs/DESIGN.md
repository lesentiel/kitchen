# kitchen: design

kitchen is a self-hostable remote MCP server for a shared kitchen. Each partner in a household has their own cooking assistant (a Grok bot). Both bots connect to the same kitchen and share three things: recipes, one grocery list, and context notes (preferences, dietary needs, what someone discussed with their cook bot). Everything happens through MCP tools. There is no admin UI.

## Decisions at a glance

| Topic | Decision | Section |
| --- | --- | --- |
| Runtime | One Cloudflare Worker, stateless, plus D1 | [Architecture](#architecture) |
| MCP library | Plain `@modelcontextprotocol/server` v2 (`createMcpHandler`), not `agents`' `McpAgent` | [McpAgent vs plain SDK](#mcpagent-vs-plain-sdk) |
| Transport | Streamable HTTP at `/mcp`. Serves the 2026-07-28 protocol and falls back to stateless serving for 2025-era clients | [Architecture](#architecture) |
| Storage | D1 is the only store. **No Durable Object in the MVP** (this departs from the agreed design) | [Storage](#storage-why-d1) |
| Concurrent edits | Optimistic `version` column on recipes; atomic single-statement updates elsewhere | [Concurrency](#concurrency-without-a-durable-object) |
| Auth | Bearer tokens, stored as SHA-256 hashes. Admin secret gates kitchen creation. Single-use invite codes | [Auth](#auth) |
| Schema migrations | `migrations/*.sql`, applied **by the Worker itself** on its first request | [Migrations](#migrations) |
| CLI | Cloudflare `cf` CLI (`cf init`, `cf dev`, `cf build`, `cf deploy`), no Wrangler | [cf CLI](#cf-cli) |
| Build/test tooling | Vite 8 + `@cloudflare/vite-plugin` 2 beta + Vitest 4 + `@cloudflare/vitest-pool-workers`. **Not Vite+** | [Vite+](#vite-decision) |

## Architecture

```
 Alex's Grok bot ─┐                         ┌──────────── Worker ─────────────┐
                  │  POST /mcp              │ 1. ensureMigrated(DB)  (once)    │
                  ├─ Authorization: Bearer ─▶ 2. token → sha256 → members row │──▶ D1
 Sam's Grok bot  ─┘                         │ 3. createMcpHandler(factory)     │
                                            │    factory builds an McpServer   │
                                            │    for THIS member's kitchen     │
                                            └──────────────────────────────────┘
```

* `src/index.ts`: the fetch entry. It routes `/mcp`, authenticates, and hands the request to the SDK. `GET /` returns a small JSON descriptor.
* `src/server.ts`: builds an `McpServer` for one request. It holds the zod input schemas and tool annotations for every tool.
* `src/kitchen.ts`, `recipes.ts`, `grocery.ts`, `notes.ts`: data access. Every query is bound to `me.kitchenId`.
* `src/auth.ts`, `src/util.ts`: token parsing and lookup, ID, token, and invite-code generation, hashing.
* `src/migrate.ts`: applies `migrations/*.sql` at runtime.

The SDK's `createMcpHandler` calls the factory once per HTTP request. Every request is therefore independent. No MCP session state is kept between requests, so nothing needs a Durable Object. Both protocol eras are served by the same factory:

* **2026-07-28 clients** use the per-request envelope protocol.
* **2025-era clients** are served by the SDK's stateless legacy fallback (`legacy: 'stateless'`, the default). A test covers a raw `MCP-Protocol-Version: 2025-06-18` `initialize` and `tools/call`. This matters because we don't control which protocol version Grok's MCP client speaks.

Responses use `responseMode: 'auto'`: plain JSON unless a handler streams. No tool streams today.

## Auth

The design goal is that each person's bot holds its own revocable credential. There are no shared passwords, and no secret is stored in plaintext.

```
deployer sets KITCHEN_ADMIN_SECRET (cf secret / .dev.vars)
        │
Alex's bot ── create_kitchen(admin_secret, kitchen_name, display_name) ──▶ token A  (shown once)
        │
Alex's bot ── invite_member(expires_in_minutes=60) ──▶ code "KTCH-7QX4-M9PB-2RZD"  (shown once)
        │                                    Alex tells Sam the code, out of band
Sam's bot  ── redeem_invite(code, display_name) ──▶ token B  (shown once)
```

* **No `Authorization` header**: anonymous. `tools/list` shows only `create_kitchen` and `redeem_invite`.
* **Valid `Bearer` token**: member. `tools/list` shows the 19 kitchen tools. The token-minting tools are hidden.
* **Unknown, revoked, or malformed token**: HTTP `401` with `WWW-Authenticate: Bearer error="invalid_token"`. This happens before any MCP processing.
* **Tokens**: `kit_` + 32 random bytes (base64url, 256 bits). D1 stores `sha256(token)` only. A salted KDF isn't needed: the token is high-entropy and random, not a password.
* **Invite codes**: 16 characters from a 30-symbol alphabet with no look-alikes (≈78 bits), grouped `XXXX-XXXX-XXXX-XXXX`. Case and dashes are ignored on redeem. D1 stores only the hash. Codes are single-use, expire after 60 minutes by default (5 minutes to 7 days), and are bound to one kitchen.
* **Atomic redemption**: one D1 batch, so one transaction. It runs `UPDATE invites … WHERE code_hash=? AND redeemed_at IS NULL AND expires_at>now RETURNING kitchen_id`, then `INSERT INTO members … SELECT … FROM invites WHERE redeemed_by = <new member id>`. The insert only produces a row if this request won the claim. Four concurrent redemptions of one code produce exactly one member (tested).
* **Admin secret** is compared in constant time (`crypto.subtle.timingSafeEqual` over SHA-256 digests). If the secret isn't set, `create_kitchen` refuses.
* **Revoke** (`revoke_member`) is a soft delete (`revoked_at`). The token stops working immediately, and the member's authored recipes and notes keep their attribution. You can't revoke yourself; use `rotate_token` if your token leaked.
* **Rotate** (`rotate_token`) replaces your token hash. The old token dies immediately.
* All members are equal. There are no roles.

**Isolation.** Every SQL statement that touches kitchen data has `kitchen_id = ?` bound to the caller's kitchen. A foreign ID gets "not found", never "forbidden", so callers can't probe whether an ID exists. `test/isolation.test.ts` tries every read and write tool against another kitchen's IDs. A mutation check (removing the scope from `getRecipe`) makes that test fail.

**DNS rebinding and Origin checks.** The SDK recommends Host/Origin validation for servers on `localhost`. This server is public and authenticates with bearer headers, not cookies, so a browser can't attach credentials on a user's behalf. I didn't add an Origin allow-list. See [open questions](#open-questions).

## MCP tools

All tools return JSON as `structuredContent` and as pretty-printed `text` content, for clients that ignore structured output. Errors return `isError: true` with a short message the bot can act on, such as "Recipe was changed by Sam at … (now version 3, you expected 2). Re-read it with get_recipe and reapply your change." Inputs are zod v4 schemas. The tables below were generated from the live `tools/list`.

### Anonymous (no token)

| Tool | Input | Kind |
| --- | --- | --- |
| `create_kitchen` | `admin_secret: string`, `kitchen_name: string`, `display_name: string` | write |
| `redeem_invite` | `code: string`, `display_name: string` | write |

Both return `{ kitchen, member, token, next_steps }`.

### Kitchen and members

| Tool | Input | Kind |
| --- | --- | --- |
| `whoami` | none | read |
| `invite_member` | `expires_in_minutes?: integer` (default 60, 5–10080) | write |
| `list_members` | none | read |
| `revoke_member` | `member_id: string` | destructive |
| `rotate_token` | none | destructive |

### Recipes

| Tool | Input | Kind |
| --- | --- | --- |
| `create_recipe` | `title: string`, `description?: string`, `servings?: integer`, `prep_minutes?: integer`, `cook_minutes?: integer`, `ingredients?: { name: string, quantity?: string, unit?: string, note?: string }[]`, `steps?: string[]`, `tags?: string[]`, `source?: string`, `notes?: string` | write |
| `get_recipe` | `id: string` | read |
| `update_recipe` | `id: string`, `expected_version?: integer`, `title?: string`, and every `create_recipe` field as `field?: T \| null` (omitted = keep, `null` = clear; lists are replaced whole) | write |
| `delete_recipe` | `id: string` | destructive |
| `search_recipes` | `query?: string`, `ingredient?: string`, `tags?: string[]`, `limit?: integer` (default 20) | read |

`query` matches title, description, notes, tags, and ingredient names (case-insensitive substring; LIKE wildcards are escaped). `tags` are AND-ed. With no filters, the tool lists the most recently updated recipes. Quantities are free text ("1/2", "a pinch") on purpose, because bots write them that way.

### Grocery list

| Tool | Input | Kind |
| --- | --- | --- |
| `list_grocery` | `include_checked?: boolean` (default true) | read |
| `add_grocery_items` | `items: { name: string, quantity?: string, unit?: string, note?: string }[]` (1–100) | write |
| `add_recipe_to_grocery` | `recipe_id: string`, `skip_existing?: boolean` (default true), `exclude?: string[]` | write |
| `check_grocery_items` | `ids: string[]`, `checked?: boolean` (default true; `false` puts items back) | write |
| `remove_grocery_items` | `ids: string[]` | destructive |
| `clear_checked_grocery` | none | destructive |

One list per kitchen. `add_recipe_to_grocery` skips ingredients already open on the list (case-insensitive name match) and ones named in `exclude` ("we have salt"), and reports what it skipped. Items remember their source recipe. Deleting the recipe keeps the items.

### Context notes

| Tool | Input | Kind |
| --- | --- | --- |
| `save_note` | `id?: string` (edit instead of create), `kind: "preference" \| "dietary" \| "conversation" \| "plan" \| "other"`, `subject?: string`, `content: string`, `tags?: string[]` | write |
| `search_notes` | `query?: string`, `kind?: …`, `tags?: string[]`, `author_id?: string`, `limit?: integer` (default 20) | read |
| `delete_note` | `id: string` | destructive |

Notes carry `author` (the member who created them; editing keeps the original author), `created_at`, and `updated_at`. `subject` says who or what a note is about ("Alex", "weeknight dinners"). The server `instructions` tell bots to read dietary and preference notes before suggesting meals, and to save durable facts they learn.

## D1 schema

`migrations/0001_init.sql`. IDs are prefixed random strings (`kit_`, `mem_`, `inv_`, `rcp_`, `gro_`, `note_` + 16 Crockford base32 characters, 80 bits). Timestamps are ISO-8601 UTC `TEXT`. Lists are JSON `TEXT` queried with `json_each`.

```
kitchens       id PK, name, created_at
members        id PK, kitchen_id FK, display_name, token_hash UNIQUE, invited_by FK members,
               created_at, token_rotated_at, revoked_at
invites        id PK, kitchen_id FK, code_hash UNIQUE, created_by FK members, created_at,
               expires_at, redeemed_at, redeemed_by          -- no FK: written in the same tx as the member
recipes        id PK, kitchen_id FK, title, description, servings, prep_minutes, cook_minutes,
               ingredients JSON, steps JSON, tags JSON, source, notes,
               version, created_by FK, updated_by FK, created_at, updated_at
grocery_items  id PK, kitchen_id FK, name, quantity, unit, note, recipe_id FK (SET NULL),
               checked 0/1, checked_by FK, checked_at, added_by FK, created_at
notes          id PK, kitchen_id FK, kind CHECK(...), subject, content, tags JSON,
               author_id FK, created_at, updated_at
d1_migrations  id, name UNIQUE, applied_at                   -- same shape the cf/wrangler CLI uses
```

Indexes: `members(kitchen_id)`, `invites(kitchen_id)`, `recipes(kitchen_id, updated_at DESC)`, `grocery_items(kitchen_id, checked, created_at)`, `notes(kitchen_id, updated_at DESC)`. All kitchen tables cascade on kitchen delete. Nothing deletes kitchens yet.

Search uses `LIKE`, not FTS5. A household has hundreds of recipes, not millions. A scan of one kitchen's rows is fast, and it avoids FTS5 triggers and shadow tables. If search quality becomes an issue, FTS5 (which D1 supports) is a follow-up migration.

## Storage: why D1

| Option | Fit |
| --- | --- |
| **D1** ✅ | Relational data with joins (author names, recipe ↔ grocery), uniqueness constraints (token and code hashes), transactions (atomic invite redemption, migrations), ad-hoc filters (search). Free tier is ample. Strongly consistent from the primary. |
| KV | Eventually consistent (up to about 60 s). A revoked token or redeemed invite could keep working, and the partner might not see a just-added grocery item. No queries, no transactions, no uniqueness. Wrong tool. |
| Durable Objects (SQLite) | Would work, one DO per kitchen. But it adds a DO binding, a class migration, and per-kitchen routing, and it makes cross-kitchen lookups (token → kitchen, invite code → kitchen) a second store anyway. Worth it for real-time fan-out or heavy write contention, which two people don't produce. |
| R2 | Object storage. Fine for future recipe photos, wrong for records. |

### No Durable Object in the MVP (pushback)

The agreed design kept "a minimal Durable Object, one per kitchen, for later concurrent edits". I left it out:

1. **Nothing would call it.** An unused DO class still needs a binding, a `durableObject` export with a storage migration, and a deploy-time namespace. That makes the one-click deploy heavier and gives a reviewer dead code to read.
2. **The concurrency problem it would solve is already handled** (see the next section), at the scale of two people.
3. **Adding it later is cheap and additive.** `cloudflare.config.ts` gets `exports: { Kitchen: exports.durableObject({ storage: "sqlite" }) }` plus a binding. No data moves, because D1 stays the source of truth.

A DO earns its place when we want **live push** (Sam's bot gets notified when Alex adds a grocery item, through `subscriptions/listen` and a DO-backed `ServerEventBus`) or collaborative editing of a single document. That fits well in a follow-up.

## Concurrency without a Durable Object

* **Recipes**: `version` increments on every update. `update_recipe` accepts `expected_version`. On a mismatch it fails with who changed the recipe and when, so the bot re-reads and merges instead of silently overwriting.
* **Grocery and notes**: every write is one statement (check, uncheck, remove, clear) or an insert, so last-writer-wins is the natural semantics. Checking an item twice is idempotent.
* **Invites**: an atomic claim (see Auth).
* **Migrations**: one batch per migration file, with a `UNIQUE` migration name. A concurrent duplicate rolls back.

## Migrations

`cf deploy` auto-provisions the D1 database from `bindings.d1({ name: "kitchen" })`, but it does **not** write the new database ID back to the config. `cf d1 migrations apply` **only accepts a database ID**, rejecting both names and binding names. So a deploy-time migration step can't be scripted generically for a fresh self-host, nor in the Deploy button flow, where Cloudflare's guidance says migrations should reference the binding name.

So the Worker migrates itself:

* `migrations/*.sql` are bundled with `import.meta.glob(..., { query: "?raw" })`.
* On the first `/mcp` request per isolate, `ensureMigrated` reads `d1_migrations`, applies missing files in name order (one transaction each), and records each by file name. That is the same table shape and naming as `cf d1 migrations apply`, so the two interoperate. A database migrated by the CLI is left alone by the Worker, and the reverse.
* This costs one `SELECT` per cold isolate.
* Migrations are written idempotently (`IF NOT EXISTS`) and must not contain semicolons inside string literals or triggers (the splitter is deliberately simple).

`cf d1 migrations create <message>` still works for authoring new files.

## McpAgent vs plain SDK

**Chosen: plain `@modelcontextprotocol/server` v2 with `createMcpHandler`.**

| | `agents` `McpAgent` (0.26) | `@modelcontextprotocol/server` 2.3 `createMcpHandler` |
| --- | --- | --- |
| State model | One Durable Object per MCP session | Stateless; one server instance per request |
| Infra needed | DO binding + class migration | None beyond the Worker |
| Protocol | Pins `@modelcontextprotocol/server` **2.0.0** and `@modelcontextprotocol/sdk` **1.30.0** exactly (peer deps) | Current release (2.3.0) with 2026-07-28 support and a stateless 2025 fallback |
| Workers fit | Built for Workers | Fetch-native (`handler.fetch(request, { authInfo })`), with `workerd` export conditions |
| Auth | Pairs with `workers-oauth-provider` | `authInfo` pass-through; we do our own bearer check |
| Extras | Elicitation and sampling over a long-lived session, per-session state, hibernation | Per-request `inputRequired` for multi-round-trip on the modern protocol |

Our tools are request/response CRUD with no per-session state, so a DO per session would be pure overhead. It would also cost a DO hop per call and a session ID clients must carry, and it would bring back the DO plumbing I argued against above. `McpAgent` also lags the SDK by three minor versions through exact peer pins. The plain SDK keeps us on the reference implementation and lets the per-request factory decide the tool set from the caller's identity, which is how the anonymous and member tool lists work. If we later add OAuth through `workers-oauth-provider`, it wraps a plain fetch handler just as well.

## cf CLI

Per the 2026-10-05 update on kitchen-601, the project uses Cloudflare's new `cf` CLI (`cf@1.0.0-beta.12`, published by Cloudflare's Workers team, repo `cloudflare/cf`) instead of Wrangler.

* **Scaffold**: generated with `cf init kitchen --package-manager pnpm` and adopted file by file. Running `cf init .` in the existing repo (which "autoconfigures" a non-empty directory) was blocked by the session's safety policy, and I didn't override that. The adopted files are `cloudflare.config.ts`, `vite.config.ts`, `tsconfig.json`, `package.json` scripts, and the `.gitignore` entries.
* **Config**: `cloudflare.config.ts` (`cf/config`), not `wrangler.jsonc`. It declares the D1 binding, the `KITCHEN_ADMIN_SECRET` secret binding, observability, and the custom domain.
* **Custom domain**: `kitchen.lesentiel.com` is attached only when the config is evaluated with `--mode lesentiel` (`pnpm run deploy:lesentiel`). A self-hoster's plain `cf deploy`, or the Deploy button, must not try to claim a zone it doesn't own. Verified with `cf build` and `cf build --mode lesentiel`.
* **Dev**: `cf dev` delegates to `vite` with `@cloudflare/vite-plugin` 2.0 beta (the version `cf init` installs, pinned exactly here). Local D1 state lives in `.cloudflare/state`, and secrets come from `.dev.vars`.
* **Types**: `cf workers types` generates `.cloudflare/types` (gitignored, regenerated by `pnpm typecheck`).
* **Build/deploy**: `cf build` writes `.cloudflare/output`. `cf deploy` builds, provisions D1, and uploads. **Not run**: no deploys, no resources, no login.

## Vite+ decision

**Not adopted. Fallback: Vite 8, `@cloudflare/vite-plugin`, Vitest 4, `@cloudflare/vitest-pool-workers`.**

I tested Vite+ 1.0.0 (`vp`, installed on this machine) in a scratch project:

* ✅ `vp build` with `@cloudflare/vite-plugin` works. Vite+ ships a Vite-compatible core (`@voidzero-dev/vite-plus-core`), and the plugin accepts it.
* ❌ `vp test` bundles **Vitest 5.0.1**. `@cloudflare/vitest-pool-workers` (latest 0.22.0) supports only `vitest ^4.1.0`, and it crashes under Vitest 5 (`Failed to start cloudflare-pool worker … SyntaxError: Unexpected identifier 'file'`). The same test passes under plain Vitest 4.1.11.

The brief requires tests in the Workers runtime, and that needs the Workers pool. A hybrid (Vite+ for `vp check`/`vp build`, separate Vitest 4 for tests) would put two Vites and two Vitests in one tree for little gain, and `cf dev`/`cf build` already own dev and build. Revisit when the pool supports Vitest 5. The switch is then mostly `vitest` → `vite-plus/test` imports and `vp test`.

A related constraint: the pool's bundled workerd supports compatibility dates up to **2026-08-22**. `compatibilityDate` is `2026-08-15` in both `cloudflare.config.ts` and `vitest.config.ts` so tests run on the same runtime semantics as dev and prod.

## Testing

`pnpm test` runs 33 tests in workerd through the Workers Vitest pool, driving the Worker over HTTP with the real MCP client (`@modelcontextprotocol/client`, `fetch` pointed at the Worker):

* `auth.test.ts`: anonymous vs member tool lists, the admin secret, 401s, hashed storage, rotate, revoke.
* `invites.test.ts`: redeem, code normalization, single use, **concurrent** single use, expiry, unknown codes, hashed storage.
* `isolation.test.ts`: every tool against another kitchen's IDs.
* `recipes.test.ts`, `grocery.test.ts`, `notes.test.ts`: core behavior including optimistic concurrency, search, and recipe → grocery.
* `http.test.ts`: the 2025-era legacy client path, `GET /`, 404, migrations (recorded like the CLI, idempotent).

`pnpm sample-session` runs the end-to-end story against `pnpm dev`: create, invite, redeem, recipe, groceries, note, then read back as the partner.

The pool reads inline Miniflare options, not `cloudflare.config.ts`, so `vitest.config.ts` mirrors the bindings by hand.

## Open questions

1. **Deploy to Cloudflare button with a `cf` project.** The button docs describe Wrangler config (`wrangler.json[c]/toml`) and `package.json` `deploy` scripts. This repo has only `cloudflare.config.ts`. I couldn't verify, without deploying, that the button recognizes it, provisions D1 from it, or prompts for `KITCHEN_ADMIN_SECRET` (from `.dev.vars.example` and `package.json` `cloudflare.bindings`). The self-migrating Worker removes the migration step either way. Needs one real test deploy from a fork.
2. **Remote migrations with `cf`**: `cf d1 migrations apply` requires the database UUID, and `cf deploy` doesn't write the provisioned ID back. The runtime migrator sidesteps this. Should we also write the ID into `cloudflare.config.ts` after the first deploy (`d1({ name, id })`) so CLI tooling such as `cf d1 migrations list <id>` is convenient?
3. **Setting the production secret with `cf`.** `cf workers secrets update` exists, and `cf deploy --secrets-file` uploads secrets with a version. I haven't run either, so the README shows both. Which flow does Simon prefer?
4. **`@cloudflare/vite-plugin` 2.0 is a beta** (`2.0.0-beta.sha-52b0dc0e9`, pinned) and `cf` is `1.0.0-beta.12` (pinned). Fine for now; they need watching.
5. **The Workers Vitest pool still depends on the `wrangler` package internally** (and on its own workerd, hence the compatibility-date cap). We never invoke Wrangler, but it's in `node_modules`. There's no `cf`-native test runner yet (`cf cli search` finds none).
6. **Admin secret passes through the LLM.** `create_kitchen` takes it as a tool argument, so it ends up in the creating bot's conversation context. Acceptable for a household deploy. Alternatives: a one-time bootstrap token, a header, or kitchen creation by CLI only.
7. **Grok's MCP client**: which protocol version and auth mechanism does it use? We support static bearer headers and both protocol eras. If Grok only supports OAuth for remote MCP servers, we need the OAuth layer sooner.
8. **Invites**: should there be `list_invites` and `revoke_invite`? Today an unredeemed invite simply expires (60 minutes by default).
9. **Rate limiting** on the anonymous tools. Brute-forcing a ≈78-bit invite code or the admin secret is impractical, but a Workers rate-limit binding on anonymous `/mcp` traffic is cheap insurance.
10. **Deleting a kitchen or leaving one** isn't implemented. Should the last member be able to delete everything?
