import type { AuthInfo } from "@modelcontextprotocol/server";
import { sha256 } from "./util.ts";

/** The authenticated caller. Every data query is scoped by `kitchenId`. */
export interface Member {
	id: string;
	kitchenId: string;
	kitchenName: string;
	displayName: string;
}

export function bearerToken(request: Request): string | null | undefined {
	const header = request.headers.get("authorization");
	if (header === null) return undefined; // anonymous
	// Clients configured with `Authorization: Bearer ${KITCHEN_TOKEN:-}` send an
	// empty bearer before the member has a token; treat that as anonymous so
	// create_kitchen / redeem_invite still work.
	if (/^\s*(Bearer\s*)?$/i.test(header)) return undefined;
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match ? match[1] : null; // null = malformed
}

export async function resolveMember(db: D1Database, token: string): Promise<Member | null> {
	const row = await db
		.prepare(
			`SELECT m.id, m.kitchen_id, m.display_name, k.name AS kitchen_name
			   FROM members m JOIN kitchens k ON k.id = m.kitchen_id
			  WHERE m.token_hash = ? AND m.revoked_at IS NULL`,
		)
		.bind(await sha256(token))
		.first<{ id: string; kitchen_id: string; display_name: string; kitchen_name: string }>();
	if (!row) return null;
	return { id: row.id, kitchenId: row.kitchen_id, kitchenName: row.kitchen_name, displayName: row.display_name };
}

export const toAuthInfo = (token: string, member: Member): AuthInfo => ({
	token,
	clientId: member.id,
	scopes: ["kitchen"],
	extra: { member },
});

export const memberFrom = (authInfo: AuthInfo | undefined): Member | undefined =>
	authInfo?.extra?.member as Member | undefined;

export function unauthorized(description: string): Response {
	return Response.json(
		{ error: "invalid_token", error_description: description },
		{
			status: 401,
			headers: { "WWW-Authenticate": `Bearer realm="kitchen", error="invalid_token", error_description="${description}"` },
		},
	);
}
