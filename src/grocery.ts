import type { Member } from "./auth.ts";
import { getRecipe } from "./recipes.ts";
import { KitchenError, newId, now } from "./util.ts";

export interface GroceryInput {
	name: string;
	quantity?: string;
	unit?: string;
	note?: string;
}

interface GroceryRow {
	id: string;
	name: string;
	quantity: string | null;
	unit: string | null;
	note: string | null;
	recipe_id: string | null;
	recipe_title: string | null;
	checked: number;
	checked_by_name: string | null;
	checked_at: string | null;
	added_by_name: string;
	created_at: string;
}

const SELECT_ITEM = `
	SELECT g.id, g.name, g.quantity, g.unit, g.note, g.recipe_id, r.title AS recipe_title,
	       g.checked, cb.display_name AS checked_by_name, g.checked_at,
	       ab.display_name AS added_by_name, g.created_at
	  FROM grocery_items g
	  JOIN members ab ON ab.id = g.added_by
	  LEFT JOIN members cb ON cb.id = g.checked_by
	  LEFT JOIN recipes r ON r.id = g.recipe_id`;

const toItem = (row: GroceryRow) => ({
	id: row.id,
	name: row.name,
	quantity: row.quantity,
	unit: row.unit,
	note: row.note,
	recipe: row.recipe_id ? { id: row.recipe_id, title: row.recipe_title } : null,
	checked: row.checked === 1,
	checked_by: row.checked_by_name,
	checked_at: row.checked_at,
	added_by: row.added_by_name,
	created_at: row.created_at,
});

async function insertItems(db: D1Database, me: Member, items: GroceryInput[], recipeId: string | null) {
	const at = now();
	const ids = items.map(() => newId("gro"));
	if (items.length === 0) return ids;
	await db.batch(
		items.map((item, i) =>
			db
				.prepare(
					`INSERT INTO grocery_items (id, kitchen_id, name, quantity, unit, note, recipe_id, added_by, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(ids[i], me.kitchenId, item.name, item.quantity ?? null, item.unit ?? null, item.note ?? null, recipeId, me.id, at),
		),
	);
	return ids;
}

async function itemsByIds(db: D1Database, me: Member, ids: string[]) {
	if (ids.length === 0) return [];
	const { results } = await db
		.prepare(
			`${SELECT_ITEM} WHERE g.kitchen_id = ? AND g.id IN (SELECT value FROM json_each(?)) ORDER BY g.created_at, g.rowid`,
		)
		.bind(me.kitchenId, JSON.stringify(ids))
		.all<GroceryRow>();
	return results.map(toItem);
}

export async function addGroceryItems(db: D1Database, me: Member, input: { items: GroceryInput[] }) {
	const ids = await insertItems(db, me, input.items, null);
	return { added: await itemsByIds(db, me, ids) };
}

export async function listGrocery(db: D1Database, me: Member, input: { include_checked: boolean }) {
	const { results } = await db
		.prepare(
			`${SELECT_ITEM} WHERE g.kitchen_id = ? ${input.include_checked ? "" : "AND g.checked = 0"}
			 ORDER BY g.checked, g.created_at, g.rowid`,
		)
		.bind(me.kitchenId)
		.all<GroceryRow>();
	const items = results.map(toItem);
	return { items, open: items.filter((i) => !i.checked).length, checked: items.filter((i) => i.checked).length };
}

export async function setChecked(db: D1Database, me: Member, input: { ids: string[]; checked: boolean }) {
	const { results } = await db
		.prepare(
			`UPDATE grocery_items
			    SET checked = ?1, checked_by = CASE WHEN ?1 = 1 THEN ?2 END, checked_at = CASE WHEN ?1 = 1 THEN ?3 END
			  WHERE kitchen_id = ?4 AND id IN (SELECT value FROM json_each(?5))
			 RETURNING id`,
		)
		.bind(input.checked ? 1 : 0, me.id, now(), me.kitchenId, JSON.stringify(input.ids))
		.all<{ id: string }>();
	const found = new Set(results.map((r) => r.id));
	return {
		updated: await itemsByIds(db, me, [...found]),
		not_found: input.ids.filter((id) => !found.has(id)),
	};
}

export async function removeGroceryItems(db: D1Database, me: Member, input: { ids: string[] }) {
	const { results } = await db
		.prepare(
			"DELETE FROM grocery_items WHERE kitchen_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id, name",
		)
		.bind(me.kitchenId, JSON.stringify(input.ids))
		.all<{ id: string; name: string }>();
	const found = new Set(results.map((r) => r.id));
	return { removed: results, not_found: input.ids.filter((id) => !found.has(id)) };
}

export async function clearChecked(db: D1Database, me: Member) {
	const { results } = await db
		.prepare("DELETE FROM grocery_items WHERE kitchen_id = ? AND checked = 1 RETURNING id, name")
		.bind(me.kitchenId)
		.all<{ id: string; name: string }>();
	return { removed: results };
}

export async function addRecipeToGrocery(
	db: D1Database,
	me: Member,
	input: { recipe_id: string; skip_existing: boolean; exclude?: string[] },
) {
	const recipe = await getRecipe(db, me, input.recipe_id);
	if (recipe.ingredients.length === 0) throw new KitchenError(`Recipe "${recipe.title}" has no ingredients.`);
	const key = (name: string) => name.trim().toLowerCase();
	const excluded = new Set((input.exclude ?? []).map(key));
	const skipped: { name: string; reason: string }[] = [];
	let open = new Set<string>();
	if (input.skip_existing) {
		const { results } = await db
			.prepare("SELECT name FROM grocery_items WHERE kitchen_id = ? AND checked = 0")
			.bind(me.kitchenId)
			.all<{ name: string }>();
		open = new Set(results.map((r) => key(r.name)));
	}
	const toAdd: GroceryInput[] = [];
	for (const ing of recipe.ingredients) {
		if (excluded.has(key(ing.name))) skipped.push({ name: ing.name, reason: "excluded" });
		else if (open.has(key(ing.name))) skipped.push({ name: ing.name, reason: "already on the list" });
		else {
			toAdd.push({ name: ing.name, quantity: ing.quantity, unit: ing.unit, note: ing.note });
			open.add(key(ing.name));
		}
	}
	const ids = await insertItems(db, me, toAdd, recipe.id);
	return { recipe: { id: recipe.id, title: recipe.title }, added: await itemsByIds(db, me, ids), skipped };
}
