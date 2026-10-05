import type { Member } from "./auth.ts";
import { KitchenError, likePattern, newId, normalizeTags, now, parseJson } from "./util.ts";

export interface Ingredient {
	name: string;
	quantity?: string;
	unit?: string;
	note?: string;
}

export interface RecipeInput {
	title: string;
	description?: string;
	servings?: number;
	prep_minutes?: number;
	cook_minutes?: number;
	ingredients?: Ingredient[];
	steps?: string[];
	tags?: string[];
	source?: string;
	notes?: string;
}

interface RecipeRow {
	id: string;
	title: string;
	description: string | null;
	servings: number | null;
	prep_minutes: number | null;
	cook_minutes: number | null;
	ingredients: string;
	steps: string;
	tags: string;
	source: string | null;
	notes: string | null;
	version: number;
	created_by: string;
	created_by_name: string;
	updated_by: string;
	updated_by_name: string;
	created_at: string;
	updated_at: string;
}

const SELECT_RECIPE = `
	SELECT r.*, c.display_name AS created_by_name, u.display_name AS updated_by_name
	  FROM recipes r
	  JOIN members c ON c.id = r.created_by
	  JOIN members u ON u.id = r.updated_by`;

function toRecipe(row: RecipeRow) {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		servings: row.servings,
		prep_minutes: row.prep_minutes,
		cook_minutes: row.cook_minutes,
		ingredients: parseJson<Ingredient[]>(row.ingredients, []),
		steps: parseJson<string[]>(row.steps, []),
		tags: parseJson<string[]>(row.tags, []),
		source: row.source,
		notes: row.notes,
		version: row.version,
		created_by: { id: row.created_by, display_name: row.created_by_name },
		updated_by: { id: row.updated_by, display_name: row.updated_by_name },
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export type Recipe = ReturnType<typeof toRecipe>;

export async function getRecipe(db: D1Database, me: Member, id: string): Promise<Recipe> {
	const row = await db
		.prepare(`${SELECT_RECIPE} WHERE r.id = ? AND r.kitchen_id = ?`)
		.bind(id, me.kitchenId)
		.first<RecipeRow>();
	if (!row) throw new KitchenError(`No recipe ${id} in this kitchen.`);
	return toRecipe(row);
}

export async function createRecipe(db: D1Database, me: Member, input: RecipeInput) {
	const id = newId("rcp");
	const at = now();
	await db
		.prepare(
			`INSERT INTO recipes (id, kitchen_id, title, description, servings, prep_minutes, cook_minutes,
			                      ingredients, steps, tags, source, notes, created_by, updated_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			me.kitchenId,
			input.title,
			input.description ?? null,
			input.servings ?? null,
			input.prep_minutes ?? null,
			input.cook_minutes ?? null,
			JSON.stringify(input.ingredients ?? []),
			JSON.stringify(input.steps ?? []),
			JSON.stringify(normalizeTags(input.tags)),
			input.source ?? null,
			input.notes ?? null,
			me.id,
			me.id,
			at,
			at,
		)
		.run();
	return { recipe: await getRecipe(db, me, id) };
}

const UPDATABLE = [
	"title",
	"description",
	"servings",
	"prep_minutes",
	"cook_minutes",
	"ingredients",
	"steps",
	"tags",
	"source",
	"notes",
] as const;

export async function updateRecipe(
	db: D1Database,
	me: Member,
	input: { id: string; expected_version?: number } & { [K in keyof RecipeInput]?: RecipeInput[K] | null },
) {
	const sets: string[] = [];
	const values: unknown[] = [];
	for (const key of UPDATABLE) {
		const value = input[key];
		if (value === undefined) continue;
		if (key === "title" && value === null) throw new KitchenError("title cannot be cleared.");
		sets.push(`${key} = ?`);
		if (key === "tags") values.push(JSON.stringify(normalizeTags((value as string[] | null) ?? [])));
		else if (key === "ingredients" || key === "steps") values.push(JSON.stringify(value ?? []));
		else values.push(value);
	}
	if (sets.length === 0) throw new KitchenError("Nothing to update: pass at least one field.");

	let sql = `UPDATE recipes SET ${sets.join(", ")}, version = version + 1, updated_by = ?, updated_at = ?
	            WHERE id = ? AND kitchen_id = ?`;
	values.push(me.id, now(), input.id, me.kitchenId);
	if (input.expected_version !== undefined) {
		sql += " AND version = ?";
		values.push(input.expected_version);
	}
	const res = await db.prepare(`${sql} RETURNING id`).bind(...values).first();
	if (!res) {
		const current = await getRecipe(db, me, input.id); // throws if missing
		throw new KitchenError(
			`Recipe was changed by ${current.updated_by.display_name} at ${current.updated_at} (now version ${current.version}, you expected ${input.expected_version}). Re-read it with get_recipe and reapply your change.`,
		);
	}
	return { recipe: await getRecipe(db, me, input.id) };
}

export async function deleteRecipe(db: D1Database, me: Member, input: { id: string }) {
	const row = await db
		.prepare("DELETE FROM recipes WHERE id = ? AND kitchen_id = ? RETURNING id, title")
		.bind(input.id, me.kitchenId)
		.first<{ id: string; title: string }>();
	if (!row) throw new KitchenError(`No recipe ${input.id} in this kitchen.`);
	return { deleted: row };
}

export async function searchRecipes(
	db: D1Database,
	me: Member,
	input: { query?: string; tags?: string[]; ingredient?: string; limit: number },
) {
	const where = ["r.kitchen_id = ?"];
	const values: unknown[] = [me.kitchenId];
	if (input.query) {
		where.push(
			`(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.notes LIKE ? ESCAPE '\\'
			  OR EXISTS (SELECT 1 FROM json_each(r.tags) t WHERE t.value LIKE ? ESCAPE '\\')
			  OR EXISTS (SELECT 1 FROM json_each(r.ingredients) i WHERE json_extract(i.value, '$.name') LIKE ? ESCAPE '\\'))`,
		);
		const p = likePattern(input.query);
		values.push(p, p, p, p, p);
	}
	if (input.ingredient) {
		where.push(
			`EXISTS (SELECT 1 FROM json_each(r.ingredients) i WHERE json_extract(i.value, '$.name') LIKE ? ESCAPE '\\')`,
		);
		values.push(likePattern(input.ingredient));
	}
	for (const tag of normalizeTags(input.tags)) {
		where.push("EXISTS (SELECT 1 FROM json_each(r.tags) t WHERE t.value = ?)");
		values.push(tag);
	}
	values.push(input.limit);
	const { results } = await db
		.prepare(`${SELECT_RECIPE} WHERE ${where.join(" AND ")} ORDER BY r.updated_at DESC LIMIT ?`)
		.bind(...values)
		.all<RecipeRow>();
	return {
		recipes: results.map((row) => {
			const r = toRecipe(row);
			return {
				id: r.id,
				title: r.title,
				description: r.description,
				tags: r.tags,
				servings: r.servings,
				total_minutes: (r.prep_minutes ?? 0) + (r.cook_minutes ?? 0) || null,
				ingredient_count: r.ingredients.length,
				updated_by: r.updated_by.display_name,
				updated_at: r.updated_at,
			};
		}),
	};
}
