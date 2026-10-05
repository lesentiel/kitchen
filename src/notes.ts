import type { Member } from "./auth.ts";
import { KitchenError, likePattern, newId, normalizeTags, now, parseJson } from "./util.ts";

export const NOTE_KINDS = ["preference", "dietary", "conversation", "plan", "other"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

interface NoteRow {
	id: string;
	kind: NoteKind;
	subject: string | null;
	content: string;
	tags: string;
	author_id: string;
	author_name: string;
	created_at: string;
	updated_at: string;
}

const SELECT_NOTE = `
	SELECT n.id, n.kind, n.subject, n.content, n.tags, n.author_id, m.display_name AS author_name,
	       n.created_at, n.updated_at
	  FROM notes n JOIN members m ON m.id = n.author_id`;

const toNote = (row: NoteRow) => ({
	id: row.id,
	kind: row.kind,
	subject: row.subject,
	content: row.content,
	tags: parseJson<string[]>(row.tags, []),
	author: { id: row.author_id, display_name: row.author_name },
	created_at: row.created_at,
	updated_at: row.updated_at,
});

async function getNote(db: D1Database, me: Member, id: string) {
	const row = await db.prepare(`${SELECT_NOTE} WHERE n.id = ? AND n.kitchen_id = ?`).bind(id, me.kitchenId).first<NoteRow>();
	if (!row) throw new KitchenError(`No note ${id} in this kitchen.`);
	return toNote(row);
}

export async function saveNote(
	db: D1Database,
	me: Member,
	input: { id?: string; kind: NoteKind; subject?: string; content: string; tags?: string[] },
) {
	const at = now();
	const tags = JSON.stringify(normalizeTags(input.tags));
	if (input.id) {
		// Editing keeps the original author; the note records who wrote it.
		const row = await db
			.prepare(
				`UPDATE notes SET kind = ?, subject = ?, content = ?, tags = ?, updated_at = ?
				  WHERE id = ? AND kitchen_id = ? RETURNING id`,
			)
			.bind(input.kind, input.subject ?? null, input.content, tags, at, input.id, me.kitchenId)
			.first();
		if (!row) throw new KitchenError(`No note ${input.id} in this kitchen.`);
		return { note: await getNote(db, me, input.id), created: false };
	}
	const id = newId("note");
	await db
		.prepare(
			`INSERT INTO notes (id, kitchen_id, kind, subject, content, tags, author_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, me.kitchenId, input.kind, input.subject ?? null, input.content, tags, me.id, at, at)
		.run();
	return { note: await getNote(db, me, id), created: true };
}

export async function searchNotes(
	db: D1Database,
	me: Member,
	input: { query?: string; kind?: NoteKind; tags?: string[]; author_id?: string; limit: number },
) {
	const where = ["n.kitchen_id = ?"];
	const values: unknown[] = [me.kitchenId];
	if (input.query) {
		const p = likePattern(input.query);
		where.push("(n.content LIKE ? ESCAPE '\\' OR n.subject LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(n.tags) t WHERE t.value LIKE ? ESCAPE '\\'))");
		values.push(p, p, p);
	}
	if (input.kind) {
		where.push("n.kind = ?");
		values.push(input.kind);
	}
	if (input.author_id) {
		where.push("n.author_id = ?");
		values.push(input.author_id);
	}
	for (const tag of normalizeTags(input.tags)) {
		where.push("EXISTS (SELECT 1 FROM json_each(n.tags) t WHERE t.value = ?)");
		values.push(tag);
	}
	values.push(input.limit);
	const { results } = await db
		.prepare(`${SELECT_NOTE} WHERE ${where.join(" AND ")} ORDER BY n.updated_at DESC LIMIT ?`)
		.bind(...values)
		.all<NoteRow>();
	return { notes: results.map(toNote) };
}

export async function deleteNote(db: D1Database, me: Member, input: { id: string }) {
	const row = await db
		.prepare("DELETE FROM notes WHERE id = ? AND kitchen_id = ? RETURNING id, kind, subject")
		.bind(input.id, me.kitchenId)
		.first();
	if (!row) throw new KitchenError(`No note ${input.id} in this kitchen.`);
	return { deleted: row };
}
