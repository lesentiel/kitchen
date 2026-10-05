# kitchen

A shared kitchen for your cooking assistants. kitchen is a small, self-hostable **remote MCP server** on Cloudflare Workers + D1. Each person in a household connects their own AI cook bot (built for Grok bots; any MCP client works). The bots then share:

- **Recipes**: create, read, update (with conflict detection), delete, search.
- **One grocery list**: add items, check them off, remove them, clear checked items, add a recipe's ingredients in one call.
- **Context notes**: preferences, dietary needs, summaries of what someone discussed with their bot, meal plans. Each note records its author and timestamps.

Everything is an MCP tool. There's no web UI. Each member has their own revocable bearer token, and partners join with single-use invite codes.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lesentiel/kitchen)

> The button has not yet been verified with this project's `cloudflare.config.ts` (the project uses the new `cf` CLI rather than Wrangler). See [open questions](docs/DESIGN.md#open-questions). The manual `cf deploy` path below is the reference.

Design notes (tool schemas, D1 schema, auth flow, trade-offs): [docs/DESIGN.md](docs/DESIGN.md).

## How it works

1. Whoever deploys the server sets a secret, `KITCHEN_ADMIN_SECRET`.
2. Your bot connects to `https://<your-worker>/mcp` **without a token** and calls `create_kitchen` with that secret. It gets back a token for you.
3. Reconnect with `Authorization: Bearer <token>`. Call `invite_member`, which returns a code like `KTCH-7QX4-M9PB-2RZD` (single use, 60 minutes by default).
4. Your partner's bot connects without a token and calls `redeem_invite` with the code. It gets back its own token.
5. Both bots now see the same recipes, grocery list, and notes.

Lost or leaked token? Call `rotate_token`. Remove someone? Call `revoke_member`.

## Requirements

- Node.js ≥ 22.18 and pnpm (npm works too)
- The `cf` CLI comes as a dev dependency: `pnpm exec cf …`, or `npx cf …`

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars        # set KITCHEN_ADMIN_SECRET to anything for local use
pnpm dev                              # cf dev → http://localhost:5173/mcp
```

The Worker creates its D1 tables on the first request, so there's no migration step. Local data lives in `.cloudflare/state`. Delete that folder to start over.

Run the end-to-end sample session against the dev server (create kitchen → invite → redeem → recipe → groceries → note → read back as the partner):

```bash
pnpm sample-session                   # or: node scripts/sample-session.ts http://localhost:5173/mcp
```

Explore by hand with the MCP Inspector: `npx @modelcontextprotocol/inspector`, Streamable HTTP, URL `http://localhost:5173/mcp`, then add an `Authorization: Bearer …` header once you have a token.

## Tests

```bash
pnpm test        # Vitest 4 + @cloudflare/vitest-pool-workers: runs inside workerd with a real D1
pnpm typecheck   # cf workers types && tsc
```

## Self-hosting with the cf CLI

```bash
pnpm install
pnpm exec cf auth login
pnpm run deploy                                       # cf deploy: builds, provisions the "kitchen" D1 database, uploads
pnpm exec cf workers secrets update KITCHEN_ADMIN_SECRET --worker kitchen --text "$(openssl rand -base64 32)"
```

Alternatively, put `KITCHEN_ADMIN_SECRET=…` in a file and pass it at deploy time with `pnpm exec cf deploy --secrets-file <file>`. Keep the secret somewhere safe: anyone who has it can create kitchens on your server.

The schema is applied by the Worker on its first request (`src/migrate.ts`), using the same `d1_migrations` bookkeeping as `cf d1 migrations apply`, so you don't need to look up the database ID.

### Custom domain

The intended production deployment is `https://kitchen.lesentiel.com/mcp`. That domain is attached only in the `lesentiel` mode:

```bash
pnpm run deploy:lesentiel                             # cf deploy --mode lesentiel
```

For your own domain, edit the `domains` line in `cloudflare.config.ts`. The zone must be on the account you deploy to. A plain `pnpm run deploy` stays on `*.workers.dev`.

## Grok plugin

`plugin/` is a Grok plugin: an MCP server config plus a skill that teaches Grok the setup flow and tools. Install it with `grok plugin install lesentiel/kitchen#plugin --trust`, then set `KITCHEN_TOKEN` (and `KITCHEN_MCP_URL` if you self-host). See [plugin/README.md](plugin/README.md). Validate changes with `grok plugin validate plugin`.

## Connecting a bot

Any MCP client that supports remote Streamable HTTP servers with custom headers:

- **URL**: `https://<your-worker-or-domain>/mcp`
- **Header**: `Authorization: Bearer kit_…` (omit it only for `create_kitchen` / `redeem_invite`)

The server speaks the 2026-07-28 MCP protocol and also serves 2025-era clients statelessly.

## Project layout

```
cloudflare.config.ts   cf config: D1 binding, secret, domain (generated by `cf init`, then extended)
migrations/            D1 schema (applied by the Worker at runtime; compatible with `cf d1 migrations`)
src/index.ts           fetch entry: homepage at /, bearer auth, MCP handler at /mcp
site/index.html        the one-page homepage (bundled into the Worker)
src/server.ts          MCP tools and zod schemas
src/{kitchen,recipes,grocery,notes}.ts   data access, always scoped to the caller's kitchen
test/                  Workers-runtime tests
scripts/               sample session
plugin/                Grok plugin (manifest, .mcp.json, skill)
docs/DESIGN.md         design and decisions
```

## License

MIT
