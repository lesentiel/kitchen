# kitchen plugin for Grok

Gives your Grok a **shared kitchen**: recipes, one grocery list, and context notes (preferences, allergies, meal plans, summaries of cooking conversations) that every assistant in your household reads and writes. Each person connects with their own member token, and a partner joins with a single-use invite code.

The plugin ships:

| Component | What it does |
| --- | --- |
| `.mcp.json` | Connects the `kitchen` MCP server (Streamable HTTP) |
| `skills/kitchen/SKILL.md` | Teaches Grok the setup flow and how to use the tools well |

The plugin has no hooks, commands, agents, or local executables.

## Install

From the xAI marketplace, once listed: open `/plugins` → **Marketplace**, find **kitchen**, and install.

From source:

```bash
grok plugin install lesentiel/kitchen#plugin --trust
```

Plugins load their MCP servers only once trusted (see `grok plugin list`).

## Configure

The plugin reads two environment variables:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KITCHEN_TOKEN` | after setup | *(empty)* | Your member token, sent as `Authorization: Bearer <token>` |
| `KITCHEN_MCP_URL` | no | `https://kitchen.lesentiel.com/mcp` | Point the plugin at a self-hosted kitchen |

Set them in your shell profile, then restart Grok:

```bash
export KITCHEN_TOKEN=kit_…                                    # from create_kitchen or redeem_invite
export KITCHEN_MCP_URL=https://kitchen.example.workers.dev/mcp  # self-hosters only
```

### First run (no token yet)

With `KITCHEN_TOKEN` unset, the server treats you as anonymous and offers only two tools. Ask Grok to "set up my kitchen" or "join my partner's kitchen":

- **`create_kitchen`**: needs the server's admin secret (`KITCHEN_ADMIN_SECRET`, chosen by whoever deployed the server). It creates the kitchen and returns your token.
- **`redeem_invite`**: needs an invite code from an existing member (`invite_member`). It returns your own token.

Store the token as `KITCHEN_TOKEN`, restart Grok, and the full tool set appears: recipes, grocery list, notes, members.

### Self-hosting

kitchen is open source (MIT). Deploy your own Worker and D1 database with the Deploy to Cloudflare button or `cf deploy`; see the [main README](https://github.com/lesentiel/kitchen#readme). Then set `KITCHEN_MCP_URL` to `https://<your-worker>/mcp`.

## Authentication and data

- **Network endpoint**: only the kitchen MCP server, `https://kitchen.lesentiel.com/mcp` by default, or your own `KITCHEN_MCP_URL`.
- **Credential**: a kitchen member bearer token (`kit_…`, 256-bit random), read from `KITCHEN_TOKEN`. The server stores only its SHA-256 hash. Revoke a member with `revoke_member`, or replace your own token with `rotate_token`.
- **Admin secret**: only needed once, to create a kitchen. It's passed as a tool argument, so it appears in that conversation.
- **Data**: recipes, grocery items, notes, and member display names are stored in the server operator's Cloudflare D1 database, scoped per kitchen. The public instance at kitchen.lesentiel.com is operated by lesentiel.
- **No telemetry.** The plugin itself runs nothing locally.

## License

MIT. See [LICENSE](LICENSE).
