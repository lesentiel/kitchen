import { describe, expect, it } from "vitest";
import { call, createCouple, createKitchen } from "./helpers.ts";

const names = (items: { name: string }[]) => items.map((i) => i.name);

describe("grocery list", () => {
	it("add, list in order, check, uncheck, remove, clear checked", async () => {
		const { a, b } = await createCouple();
		const { added } = await call(a.client, "add_grocery_items", {
			items: [{ name: "Milk", quantity: "2", unit: "L" }, { name: "Bread" }, { name: "Apples", note: "Honeycrisp" }],
		});
		expect(names(added)).toEqual(["Milk", "Bread", "Apples"]);
		expect(added[0]).toMatchObject({ quantity: "2", unit: "L", checked: false, added_by: "Alex" });
		const [milk, bread, apples] = added.map((i: { id: string }) => i.id);

		const checked = await call(b.client, "check_grocery_items", { ids: [milk, "gro_missing"] });
		expect(checked.updated[0]).toMatchObject({ name: "Milk", checked: true, checked_by: "Sam" });
		expect(checked.not_found).toEqual(["gro_missing"]);

		let list = await call(a.client, "list_grocery", {});
		expect(names(list.items)).toEqual(["Bread", "Apples", "Milk"]); // open first
		expect(list).toMatchObject({ open: 2, checked: 1 });
		expect(names((await call(a.client, "list_grocery", { include_checked: false })).items)).toEqual(["Bread", "Apples"]);

		const unchecked = await call(a.client, "check_grocery_items", { ids: [milk], checked: false });
		expect(unchecked.updated[0]).toMatchObject({ checked: false, checked_by: null, checked_at: null });

		await call(a.client, "check_grocery_items", { ids: [milk, bread] });
		expect(names((await call(a.client, "remove_grocery_items", { ids: [apples] })).removed)).toEqual(["Apples"]);
		expect(names((await call(b.client, "clear_checked_grocery")).removed).sort()).toEqual(["Bread", "Milk"]);
		list = await call(a.client, "list_grocery", {});
		expect(list.items).toEqual([]);
	});

	it("adds a recipe's ingredients, skipping open duplicates and exclusions", async () => {
		const { client } = await createKitchen();
		const { recipe } = await call(client, "create_recipe", {
			title: "Dal",
			ingredients: [
				{ name: "Red lentils", quantity: "1", unit: "cup" },
				{ name: "Onion" },
				{ name: "Garlic", quantity: "3", unit: "cloves" },
				{ name: "Salt" },
			],
		});
		await call(client, "add_grocery_items", { items: [{ name: "onion" }] });

		const res = await call(client, "add_recipe_to_grocery", { recipe_id: recipe.id, exclude: ["salt"] });
		expect(names(res.added)).toEqual(["Red lentils", "Garlic"]);
		expect(res.added[0]).toMatchObject({ quantity: "1", unit: "cup", recipe: { id: recipe.id, title: "Dal" } });
		expect(res.skipped).toEqual([
			{ name: "Onion", reason: "already on the list" },
			{ name: "Salt", reason: "excluded" },
		]);

		const again = await call(client, "add_recipe_to_grocery", { recipe_id: recipe.id, skip_existing: false });
		expect(again.added).toHaveLength(4);
	});

	it("keeps grocery items when their recipe is deleted", async () => {
		const { client } = await createKitchen();
		const { recipe } = await call(client, "create_recipe", { title: "Toast", ingredients: [{ name: "Bread" }] });
		await call(client, "add_recipe_to_grocery", { recipe_id: recipe.id });
		await call(client, "delete_recipe", { id: recipe.id });
		const { items } = await call(client, "list_grocery", {});
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ name: "Bread", recipe: null });
	});
});
