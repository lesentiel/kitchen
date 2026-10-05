import type { CallToolResult } from "@modelcontextprotocol/server";

/** An error whose message is safe to show to the calling bot. */
export class KitchenError extends Error {}

export const now = () => new Date().toISOString();

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

function randomChars(length: number, alphabet: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const b of bytes) out += alphabet[b % alphabet.length]; // 256 % 32 == 0: unbiased
	return out;
}

/** Short prefixed id, e.g. `rcp_8f3k2m9q4t7v1x0z`. 80 bits of randomness. */
export const newId = (prefix: string) => `${prefix}_${randomChars(16, ID_ALPHABET)}`;

export function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Member bearer token: 256 bits of randomness. */
export const newToken = () => `kit_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
/** Invite code, e.g. `KTCH-7QX4-M9PB-2RZD`: ~78 bits, easy to read aloud. */
export function newInviteCode(): string {
	// Rejection sampling: 30 symbols does not divide 256.
	let raw = "";
	while (raw.length < 16) {
		for (const b of crypto.getRandomValues(new Uint8Array(32))) {
			if (b < 240 && raw.length < 16) raw += INVITE_ALPHABET[b % 30];
		}
	}
	return raw.match(/.{4}/g)!.join("-");
}

/** Normalize a typed-in invite code: uppercase, drop spaces and dashes. */
export const normalizeInviteCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return base64url(new Uint8Array(digest));
}

/** Constant-time string comparison (hashes both sides so lengths match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

/** Escape LIKE wildcards; pair with `ESCAPE '\'`. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
	if (!text) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
};

export const normalizeTags = (tags: string[] | undefined) =>
	[...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];

/** Successful tool result: JSON text for any client, plus structured content. */
export function ok(data: Record<string, unknown>): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
		structuredContent: data,
	};
}

export function fail(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a tool body: data becomes a result, KitchenErrors become tool errors. */
export async function run(body: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
	try {
		return ok(await body());
	} catch (err) {
		if (err instanceof KitchenError) return fail(err.message);
		console.error("tool failed", err);
		return fail("Internal error. Try again; if it persists, check the Worker logs.");
	}
}
