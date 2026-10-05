import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, callError, connect, createKitchen } from "./helpers.ts";

describe("invites", () => {
	it("partner redeems an invite and joins the same kitchen", async () => {
		const owner = await createKitchen("Ours", "Alex");
		const { invite } = await call(owner.client, "invite_member", { expires_in_minutes: 30 });
		expect(invite.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

		const joined = await call(await connect(), "redeem_invite", { code: invite.code, display_name: "Sam" });
		expect(joined.kitchen).toEqual({ id: owner.kitchenId, name: "Ours" });

		const sam = await connect(joined.token);
		const { members } = await call(sam, "list_members");
		expect(members.map((m: { display_name: string }) => m.display_name)).toEqual(["Alex", "Sam"]);
		expect(members[1]).toMatchObject({ invited_by: owner.memberId, is_me: true });
	});

	it("accepts codes with different case and spacing", async () => {
		const owner = await createKitchen();
		const { invite } = await call(owner.client, "invite_member", {});
		const sloppy = invite.code.toLowerCase().replaceAll("-", " ");
		await call(await connect(), "redeem_invite", { code: sloppy, display_name: "Sam" });
	});

	it("is single-use", async () => {
		const owner = await createKitchen();
		const { invite } = await call(owner.client, "invite_member", {});
		await call(await connect(), "redeem_invite", { code: invite.code, display_name: "Sam" });
		const err = await callError(await connect(), "redeem_invite", { code: invite.code, display_name: "Eve" });
		expect(err).toMatch(/invalid, expired, or already used/);
	});

	it("is single-use under concurrent redemption", async () => {
		const owner = await createKitchen();
		const { invite } = await call(owner.client, "invite_member", {});
		const anon = await connect();
		const results = await Promise.all(
			["P1", "P2", "P3", "P4"].map((name) =>
				anon.callTool({ name: "redeem_invite", arguments: { code: invite.code, display_name: name } }),
			),
		);
		expect(results.filter((r) => !r.isError)).toHaveLength(1);
		const { members } = await call(owner.client, "list_members");
		expect(members).toHaveLength(2);
	});

	it("expires", async () => {
		const owner = await createKitchen();
		const { invite } = await call(owner.client, "invite_member", { expires_in_minutes: 5 });
		await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), invite.id)
			.run();
		await callError(await connect(), "redeem_invite", { code: invite.code, display_name: "Late" });
	});

	it("rejects unknown codes", async () => {
		await callError(await connect(), "redeem_invite", { code: "AAAA-BBBB-CCCC-DDDD", display_name: "X" });
	});

	it("stores only code hashes", async () => {
		const owner = await createKitchen();
		const { invite } = await call(owner.client, "invite_member", {});
		const row = await env.DB.prepare("SELECT * FROM invites WHERE id = ?").bind(invite.id).first();
		expect(JSON.stringify(row)).not.toContain(invite.code.replaceAll("-", ""));
	});
});
