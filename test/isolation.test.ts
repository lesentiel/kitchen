import { describe, expect, it } from "vitest";
import { call, callError, createCouple, createKitchen } from "./helpers.ts";

// Two kitchens; everything one creates must be invisible and untouchable to the other.
describe("kitchen isolation", () => {
	it("keeps recipes, groceries, notes, and members separate", async () => {
		const ours = await createCouple();
		const theirs = await createKitchen("Neighbors", "Eve");

		const { recipe } = await call(ours.a.client, "create_recipe", {
			title: "Secret Pasta",
			ingredients: [{ name: "garlic" }],
		});
		const { added } = await call(ours.a.client, "add_grocery_items", { items: [{ name: "garlic" }] });
		const { note } = await call(ours.b.client, "save_note", { kind: "dietary", content: "Sam is vegetarian" });

		const eve = theirs.client;
		// Reads see nothing.
		expect((await call(eve, "search_recipes", {})).recipes).toEqual([]);
		expect((await call(eve, "search_recipes", { query: "Secret" })).recipes).toEqual([]);
		expect((await call(eve, "list_grocery", {})).items).toEqual([]);
		expect((await call(eve, "search_notes", {})).notes).toEqual([]);
		expect((await call(eve, "list_members")).members).toHaveLength(1);
		expect((await call(eve, "whoami")).counts).toEqual({ members: 1, recipes: 0, open_grocery_items: 0, notes: 0 });

		// Direct access by id fails as "not found", never as "forbidden" (no existence leak).
		expect(await callError(eve, "get_recipe", { id: recipe.id })).toMatch(/No recipe/);
		await callError(eve, "update_recipe", { id: recipe.id, title: "Mine now" });
		await callError(eve, "delete_recipe", { id: recipe.id });
		await callError(eve, "add_recipe_to_grocery", { recipe_id: recipe.id });
		await callError(eve, "delete_note", { id: note.id });
		await callError(eve, "save_note", { id: note.id, kind: "other", content: "overwritten" });
		await callError(eve, "revoke_member", { member_id: ours.b.memberId });

		const checked = await call(eve, "check_grocery_items", { ids: [added[0].id] });
		expect(checked).toEqual({ updated: [], not_found: [added[0].id] });
		const removed = await call(eve, "remove_grocery_items", { ids: [added[0].id] });
		expect(removed).toEqual({ removed: [], not_found: [added[0].id] });
		await call(eve, "clear_checked_grocery");

		// And our data is untouched.
		expect((await call(ours.b.client, "get_recipe", { id: recipe.id })).recipe.title).toBe("Secret Pasta");
		const list = await call(ours.b.client, "list_grocery", {});
		expect(list.items).toHaveLength(1);
		expect(list.items[0].checked).toBe(false);
		expect((await call(ours.a.client, "search_notes", {})).notes[0].content).toBe("Sam is vegetarian");
		expect((await call(ours.a.client, "list_members")).members.every((m: { active: boolean }) => m.active)).toBe(true);
	});
});
