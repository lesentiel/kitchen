import { env } from "cloudflare:workers";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { bearerToken, memberFrom, resolveMember, toAuthInfo, unauthorized } from "./auth.ts";
import { ensureMigrated } from "./migrate.ts";
import { SERVER_INFO, createServer } from "./server.ts";

export const MCP_PATH = "/mcp";

// Stateless: the SDK builds a fresh McpServer per request from this factory.
// Modern (2026-07-28) clients get the per-request protocol; 2025-era clients
// are served by the SDK's stateless legacy fallback. No sessions to store.
const mcp = createMcpHandler(
	({ authInfo }) => createServer({ db: env.DB, adminSecret: env.KITCHEN_ADMIN_SECRET }, memberFrom(authInfo)),
	{ onerror: (err) => console.error("mcp", err) },
);

export default {
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === MCP_PATH) {
			await ensureMigrated(env.DB);
			const token = bearerToken(request);
			if (token === undefined) return mcp.fetch(request); // anonymous: create_kitchen / redeem_invite only
			if (token === null) return unauthorized("Malformed Authorization header; expected `Bearer <token>`.");
			const member = await resolveMember(env.DB, token);
			if (!member) return unauthorized("Unknown or revoked token.");
			return mcp.fetch(request, { authInfo: toAuthInfo(token, member) });
		}

		if (url.pathname === "/" && request.method === "GET") {
			return Response.json({
				name: SERVER_INFO.name,
				version: SERVER_INFO.version,
				mcp: new URL(MCP_PATH, url).href,
				docs: "https://github.com/lesentiel/kitchen#readme",
			});
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
