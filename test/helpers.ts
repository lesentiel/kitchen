import { exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect } from "vitest";

export const ADMIN_SECRET = "test-admin-secret";
const MCP_URL = new URL("https://kitchen.test/mcp");

/** Send a request to the Worker under test. */
export const workerFetch = (input: RequestInfo | URL, init?: RequestInit) =>
	exports.default.fetch(new Request(input, init));

/** An MCP client connected to the Worker, optionally as a member. */
export async function connect(token?: string): Promise<Client> {
	const client = new Client({ name: "kitchen-test", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(MCP_URL, {
		fetch: workerFetch,
		requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
	});
	await client.connect(transport);
	return client;
}

// biome-ignore lint: test helper returns loosely typed JSON
type Json = any;

/** Call a tool and return its structured result; fails the test on a tool error. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Json> {
	const result = await client.callTool({ name, arguments: args });
	if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
	return result.structuredContent;
}

/** Call a tool that must fail; returns the error text. */
export async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
	const result = await client.callTool({ name, arguments: args });
	expect(result.isError, `${name} should fail`).toBe(true);
	return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

export async function createKitchen(name = "Test Kitchen", displayName = "Owner") {
	const anon = await connect();
	const res = await call(anon, "create_kitchen", {
		admin_secret: ADMIN_SECRET,
		kitchen_name: name,
		display_name: displayName,
	});
	return { token: res.token as string, memberId: res.member.id as string, kitchenId: res.kitchen.id as string, client: await connect(res.token) };
}

/** A kitchen with two members: `a` created it, `b` joined with an invite. */
export async function createCouple() {
	const a = await createKitchen("Couple", "Alex");
	const invite = await call(a.client, "invite_member", {});
	const anon = await connect();
	const joined = await call(anon, "redeem_invite", { code: invite.invite.code, display_name: "Sam" });
	const b = { token: joined.token as string, memberId: joined.member.id as string, client: await connect(joined.token) };
	return { a, b, kitchenId: a.kitchenId };
}
