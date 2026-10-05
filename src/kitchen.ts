import type { Member } from "./auth.ts";
import { KitchenError, newId, newInviteCode, newToken, normalizeInviteCode, now, safeEqual, sha256 } from "./util.ts";

export async function createKitchen(
	db: D1Database,
	adminSecret: string | undefined,
	input: { admin_secret: string; kitchen_name: string; display_name: string },
) {
	if (!adminSecret) {
		throw new KitchenError("Kitchen creation is disabled: the KITCHEN_ADMIN_SECRET secret is not set on this server.");
	}
	if (!(await safeEqual(input.admin_secret, adminSecret))) {
		throw new KitchenError("Wrong admin secret.");
	}
	const kitchenId = newId("kit");
	const memberId = newId("mem");
	const token = newToken();
	const at = now();
	await db.batch([
		db.prepare("INSERT INTO kitchens (id, name, created_at) VALUES (?, ?, ?)").bind(kitchenId, input.kitchen_name, at),
		db
			.prepare("INSERT INTO members (id, kitchen_id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
			.bind(memberId, kitchenId, input.display_name, await sha256(token), at),
	]);
	return {
		kitchen: { id: kitchenId, name: input.kitchen_name },
		member: { id: memberId, display_name: input.display_name },
		token,
		next_steps:
			"Store this token now; it is shown once. Send it as `Authorization: Bearer <token>` on every request to this MCP server, then call invite_member to bring in your partner.",
	};
}

export async function inviteMember(db: D1Database, me: Member, input: { expires_in_minutes: number }) {
	const code = newInviteCode();
	const id = newId("inv");
	const at = new Date();
	const expiresAt = new Date(at.getTime() + input.expires_in_minutes * 60_000).toISOString();
	await db
		.prepare(
			"INSERT INTO invites (id, kitchen_id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(id, me.kitchenId, await sha256(normalizeInviteCode(code)), me.id, at.toISOString(), expiresAt)
		.run();
	return {
		invite: { id, code, expires_at: expiresAt, single_use: true },
		next_steps:
			"Give this code to your partner. Their bot connects to this MCP server without a token and calls redeem_invite with the code to get its own token.",
	};
}

export async function redeemInvite(db: D1Database, input: { code: string; display_name: string }) {
	const codeHash = await sha256(normalizeInviteCode(input.code));
	const memberId = newId("mem");
	const token = newToken();
	const at = now();
	// Claim the invite and create the member in one transaction. The member
	// insert only produces a row if the claim succeeded, so a code can be
	// redeemed at most once even under concurrent redemptions.
	const [claim] = await db.batch<{ kitchen_id: string }>([
		db
			.prepare(
				`UPDATE invites SET redeemed_at = ?1, redeemed_by = ?2
				  WHERE code_hash = ?3 AND redeemed_at IS NULL AND expires_at > ?1
				 RETURNING kitchen_id`,
			)
			.bind(at, memberId, codeHash),
		db
			.prepare(
				`INSERT INTO members (id, kitchen_id, display_name, token_hash, invited_by, created_at)
				 SELECT ?1, kitchen_id, ?2, ?3, created_by, ?4 FROM invites WHERE code_hash = ?5 AND redeemed_by = ?1`,
			)
			.bind(memberId, input.display_name, await sha256(token), at, codeHash),
	]);
	const kitchenId = claim.results[0]?.kitchen_id;
	if (!kitchenId) throw new KitchenError("Invite code is invalid, expired, or already used. Ask for a new one.");
	const kitchen = await db.prepare("SELECT id, name FROM kitchens WHERE id = ?").bind(kitchenId).first<{ id: string; name: string }>();
	return {
		kitchen,
		member: { id: memberId, display_name: input.display_name },
		token,
		next_steps:
			"Store this token now; it is shown once. Send it as `Authorization: Bearer <token>` on every request to this MCP server.",
	};
}

export async function whoami(db: D1Database, me: Member) {
	const counts = await db
		.prepare(
			`SELECT (SELECT count(*) FROM members WHERE kitchen_id = ?1 AND revoked_at IS NULL) AS members,
			        (SELECT count(*) FROM recipes WHERE kitchen_id = ?1) AS recipes,
			        (SELECT count(*) FROM grocery_items WHERE kitchen_id = ?1 AND checked = 0) AS open_grocery_items,
			        (SELECT count(*) FROM notes WHERE kitchen_id = ?1) AS notes`,
		)
		.bind(me.kitchenId)
		.first();
	return {
		kitchen: { id: me.kitchenId, name: me.kitchenName },
		me: { id: me.id, display_name: me.displayName },
		counts,
	};
}

export async function listMembers(db: D1Database, me: Member) {
	const { results } = await db
		.prepare(
			`SELECT id, display_name, created_at, invited_by, revoked_at
			   FROM members WHERE kitchen_id = ? ORDER BY created_at`,
		)
		.bind(me.kitchenId)
		.all<{ id: string; display_name: string; created_at: string; invited_by: string | null; revoked_at: string | null }>();
	return {
		members: results.map((m) => ({ ...m, active: m.revoked_at === null, is_me: m.id === me.id })),
	};
}

export async function revokeMember(db: D1Database, me: Member, input: { member_id: string }) {
	if (input.member_id === me.id) {
		throw new KitchenError("You cannot revoke yourself. Ask another member to do it, or use rotate_token if your token leaked.");
	}
	const row = await db
		.prepare(
			`UPDATE members SET revoked_at = ? WHERE id = ? AND kitchen_id = ? AND revoked_at IS NULL
			 RETURNING id, display_name`,
		)
		.bind(now(), input.member_id, me.kitchenId)
		.first<{ id: string; display_name: string }>();
	if (!row) throw new KitchenError(`No active member ${input.member_id} in this kitchen.`);
	return { revoked: row };
}

export async function rotateToken(db: D1Database, me: Member) {
	const token = newToken();
	await db
		.prepare("UPDATE members SET token_hash = ?, token_rotated_at = ? WHERE id = ? AND kitchen_id = ?")
		.bind(await sha256(token), now(), me.id, me.kitchenId)
		.run();
	return {
		token,
		next_steps: "Your old token stopped working just now. Update your MCP client configuration with this new token.",
	};
}
