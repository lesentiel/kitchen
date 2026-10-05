import { describe, expect, it } from "vitest";
import { call, callError, createCouple, createKitchen } from "./helpers.ts";

const shakshuka = {
	title: "Shakshuka",
	description: "Eggs poached in spiced tomato sauce",
	servings: 2,
	prep_minutes: 10,
	cook_minutes: 20,
	ingredients: [
		{ name: "Eggs", quantity: "4" },
		{ name: "Crushed tomatoes", quantity: "1", unit: "can" },
		{ name: "Onion", quantity: "1", note: "diced" },
	],
	steps: ["Soften the onion", "Add tomatoes and spices", "Crack in eggs, cover until set"],
	tags: ["Breakfast", "vegetarian", "breakfast"],
	source: "Alex's mom",
};

describe("recipes", () => {
	it("create and read back with authorship", async () => {
		const { a, b } = await createCouple();
		const { recipe } = await call(a.client, "create_recipe", shakshuka);
		expect(recipe).toMatchObject({
			title: "Shakshuka",
			servings: 2,
			tags: ["breakfast", "vegetarian"],
			version: 1,
			created_by: { display_name: "Alex" },
		});
		const read = (await call(b.client, "get_recipe", { id: recipe.id })).recipe;
		expect(read.ingredients).toEqual(shakshuka.ingredients);
		expect(read.steps).toEqual(shakshuka.steps);
	});

	it("update merges fields, clears with null, bumps version, records editor", async () => {
		const { a, b } = await createCouple();
		const { recipe } = await call(a.client, "create_recipe", shakshuka);
		const { recipe: updated } = await call(b.client, "update_recipe", {
			id: recipe.id,
			servings: 4,
			source: null,
			tags: ["brunch"],
		});
		expect(updated).toMatchObject({
			title: "Shakshuka",
			servings: 4,
			source: null,
			tags: ["brunch"],
			version: 2,
			created_by: { display_name: "Alex" },
			updated_by: { display_name: "Sam" },
		});
		expect(updated.ingredients).toHaveLength(3);
	});

	it("update with a stale expected_version is rejected", async () => {
		const { a, b } = await createCouple();
		const { recipe } = await call(a.client, "create_recipe", shakshuka);
		await call(b.client, "update_recipe", { id: recipe.id, expected_version: 1, notes: "More cumin" });
		const err = await callError(a.client, "update_recipe", { id: recipe.id, expected_version: 1, notes: "Less salt" });
		expect(err).toMatch(/changed by Sam.*now version 2/);
		const now = (await call(a.client, "get_recipe", { id: recipe.id })).recipe;
		expect(now.notes).toBe("More cumin");
	});

	it("update rejects empty patches and clearing the title", async () => {
		const { client } = await createKitchen();
		const { recipe } = await call(client, "create_recipe", { title: "Toast" });
		expect(await callError(client, "update_recipe", { id: recipe.id })).toMatch(/Nothing to update/);
		await callError(client, "update_recipe", { id: recipe.id, title: null });
	});

	it("delete removes the recipe", async () => {
		const { client } = await createKitchen();
		const { recipe } = await call(client, "create_recipe", { title: "Toast" });
		expect((await call(client, "delete_recipe", { id: recipe.id })).deleted.title).toBe("Toast");
		await callError(client, "get_recipe", { id: recipe.id });
		await callError(client, "delete_recipe", { id: recipe.id });
	});

	it("search by text, ingredient, and tags", async () => {
		const { client } = await createKitchen();
		await call(client, "create_recipe", shakshuka);
		await call(client, "create_recipe", {
			title: "Dal",
			ingredients: [{ name: "Red lentils" }, { name: "Onion" }],
			tags: ["dinner", "vegetarian"],
			notes: "Great with rice",
		});
		await call(client, "create_recipe", { title: "100% rye bread", tags: ["baking"] });

		const titles = async (args: Record<string, unknown>) =>
			(await call(client, "search_recipes", args)).recipes.map((r: { title: string }) => r.title).sort();

		expect(await titles({})).toEqual(["100% rye bread", "Dal", "Shakshuka"]);
		expect(await titles({ query: "tomato" })).toEqual(["Shakshuka"]); // description + ingredient
		expect(await titles({ query: "lentil" })).toEqual(["Dal"]); // ingredient name
		expect(await titles({ query: "rice" })).toEqual(["Dal"]); // notes
		expect(await titles({ query: "BRUNCH" })).toEqual([]);
		expect(await titles({ query: "name" })).toEqual([]); // JSON keys are not searchable text
		expect(await titles({ query: "%" })).toEqual(["100% rye bread"]); // LIKE wildcards are escaped
		expect(await titles({ ingredient: "onion" })).toEqual(["Dal", "Shakshuka"]);
		expect(await titles({ tags: ["vegetarian"] })).toEqual(["Dal", "Shakshuka"]);
		expect(await titles({ tags: ["Vegetarian", "dinner"] })).toEqual(["Dal"]);
		expect(await titles({ limit: 1 })).toHaveLength(1);
	});
});
