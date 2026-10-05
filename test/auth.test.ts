import { describe, expect, it } from "vitest";
import { ADMIN_SECRET, call, callError, connect, createCouple, createKitchen, workerFetch } from "./helpers.ts";

const ANON_TOOLS = ["create_kitchen", "redeem_invite"];

describe("auth", () => {
	it("anonymous callers only see the token-minting tools", async () => {
		const anon = await connect();
		const { tools } = await anon.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(ANON_TOOLS);
	});

	it("members see the kitchen tools and not the anonymous ones", async () => {
		const { client } = await createKitchen();
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["whoami", "create_recipe", "save_note", "add_recipe_to_grocery"]));
		expect(names).not.toEqual(expect.arrayContaining(ANON_TOOLS));
	});

	it("create_kitchen rejects a wrong admin secret", async () => {
		const anon = await connect();
		const err = await callError(anon, "create_kitchen", {
			admin_secret: "nope",
			kitchen_name: "K",
			display_name: "X",
		});
		expect(err).toMatch(/wrong admin secret/i);
	});

	it("create_kitchen returns a working token", async () => {
		const { client, kitchenId } = await createKitchen("Home", "Simon");
		const me = await call(client, "whoami");
		expect(me.kitchen).toEqual({ id: kitchenId, name: "Home" });
		expect(me.me.display_name).toBe("Simon");
	});

	it("rejects unknown and malformed tokens with 401", async () => {
		for (const header of ["Bearer kit_not-a-real-token", "Basic abc"]) {
			const res = await workerFetch("https://kitchen.test/mcp", {
				method: "POST",
				headers: { Authorization: header, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			});
			expect(res.status).toBe(401);
			expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer /);
		}
	});

	it("stores only token hashes", async () => {
		const { token } = await createKitchen();
		const { env } = await import("cloudflare:workers");
		const { results } = await env.DB.prepare("SELECT token_hash FROM members").all<{ token_hash: string }>();
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) expect(r.token_hash).not.toContain(token);
		expect(results.some((r) => r.token_hash === token)).toBe(false);
	});

	it("rotate_token invalidates the old token", async () => {
		const { client, token } = await createKitchen();
		const { token: fresh } = await call(client, "rotate_token");
		expect(fresh).not.toBe(token);
		await expect(connect(token)).rejects.toThrow();
		const me = await call(await connect(fresh), "whoami");
		expect(me.me.display_name).toBe("Owner");
	});

	it("revoke_member cuts off the other member but keeps their data", async () => {
		const { a, b } = await createCouple();
		await call(b.client, "save_note", { kind: "preference", content: "Sam hates cilantro" });
		await callError(a.client, "revoke_member", { member_id: a.memberId }); // not yourself
		const { revoked } = await call(a.client, "revoke_member", { member_id: b.memberId });
		expect(revoked.display_name).toBe("Sam");
		await expect(connect(b.token)).rejects.toThrow();
		const { members } = await call(a.client, "list_members");
		expect(members.find((m: { id: string }) => m.id === b.memberId)).toMatchObject({ active: false });
		const { notes } = await call(a.client, "search_notes", { query: "cilantro" });
		expect(notes[0].author.display_name).toBe("Sam");
	});

	it("mints 256-bit base64url tokens", async () => {
		const anon = await connect();
		const res = await call(anon, "create_kitchen", { admin_secret: ADMIN_SECRET, kitchen_name: "K", display_name: "X" });
		expect(res.token).toMatch(/^kit_[A-Za-z0-9_-]{43}$/);
	});
});
