import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, splitStatements } from "../src/migrate.ts";
import { createKitchen, workerFetch } from "./helpers.ts";

/** Parse a JSON or SSE response body into its JSON-RPC message. */
async function rpcBody(res: Response) {
	const text = await res.text();
	if (res.headers.get("content-type")?.includes("text/event-stream")) {
		const data = text.split("\n").find((l) => l.startsWith("data: "));
		return JSON.parse(data!.slice(6));
	}
	return JSON.parse(text);
}

function legacyPost(body: unknown, token?: string) {
	return workerFetch("https://kitchen.test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe("http", () => {
	it("serves 2025-era (pre-2026-07-28) clients statelessly", async () => {
		const init = await legacyPost({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
		});
		expect(init.status).toBe(200);
		expect((await rpcBody(init)).result.serverInfo.name).toBe("kitchen");

		const { token } = await createKitchen("Legacy", "Old Bot");
		const res = await legacyPost(
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } },
			token,
		);
		const body = await rpcBody(res);
		expect(body.result.structuredContent.me.display_name).toBe("Old Bot");
	});

	it("GET / describes the server; unknown paths 404", async () => {
		const info = await workerFetch("https://kitchen.test/");
		expect(await info.json()).toMatchObject({ name: "kitchen", mcp: "https://kitchen.test/mcp" });
		expect((await workerFetch("https://kitchen.test/nope")).status).toBe(404);
	});
});

describe("migrations", () => {
	it("are applied by the Worker and recorded like `cf d1 migrations apply`", async () => {
		await workerFetch("https://kitchen.test/mcp", { method: "POST" }); // triggers ensureMigrated
		const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
		expect(results.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
		expect(MIGRATIONS[0].name).toBe("0001_init.sql");
	});

	it("are idempotent", async () => {
		await migrate(env.DB);
		expect(await migrate(env.DB)).toEqual([]);
	});

	it("split statements without comments", () => {
		expect(splitStatements("-- a; b\nCREATE TABLE x (a TEXT); -- c\n\nSELECT 1;")).toEqual([
			"CREATE TABLE x (a TEXT)",
			"SELECT 1",
		]);
	});
});
