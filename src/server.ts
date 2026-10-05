import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Member } from "./auth.ts";
import * as grocery from "./grocery.ts";
import * as kitchen from "./kitchen.ts";
import { NOTE_KINDS } from "./notes.ts";
import * as notes from "./notes.ts";
import * as recipes from "./recipes.ts";
import { run } from "./util.ts";

export const SERVER_INFO = { name: "kitchen", version: "0.1.0" };

export interface ServerDeps {
	db: D1Database;
	adminSecret: string | undefined;
}

const INSTRUCTIONS = `kitchen is a shared kitchen for a household: recipes, one shared grocery list, and context notes (preferences, dietary needs, what was discussed with the cook bot) that every member's assistant can read and write.

Without a token you can only call create_kitchen (needs the server's admin secret) or redeem_invite (needs an invite code from an existing member). Both return a bearer token: send it as "Authorization: Bearer <token>" on every later request, then reconnect to see the full tool list.

Before suggesting meals, read the relevant notes (search_notes with kind "dietary" or "preference"). Save new durable facts you learn as notes so the other members' assistants see them.`;

// ---- shared schemas --------------------------------------------------------

const id = (what: string) => z.string().min(1).max(64).describe(`${what} id`);
const ids = (what: string) => z.array(id(what)).min(1).max(100);
const shortText = (max = 200) => z.string().trim().min(1).max(max);
const tags = z.array(shortText(40)).max(20).describe("Free-form tags, stored lowercased");
const limit = z.number().int().min(1).max(100).default(20);

const ingredient = z.object({
	name: shortText().describe('Ingredient, e.g. "yellow onion"'),
	quantity: z.string().trim().max(40).optional().describe('Free text, e.g. "2", "1/2", "a pinch"'),
	unit: z.string().trim().max(40).optional().describe('e.g. "cup", "g", "clove"'),
	note: z.string().trim().max(200).optional().describe('e.g. "finely diced"'),
});

const recipeFields = {
	description: z.string().max(2000),
	servings: z.number().int().min(1).max(100),
	prep_minutes: z.number().int().min(0).max(10_000),
	cook_minutes: z.number().int().min(0).max(10_000),
	ingredients: z.array(ingredient).max(200),
	steps: z.array(z.string().trim().min(1).max(2000)).max(100).describe("Ordered steps"),
	tags,
	source: z.string().max(500).describe("URL, cookbook, or person the recipe came from"),
	notes: z.string().max(4000).describe("Tips, substitutions, how it turned out"),
};

const groceryItem = z.object({
	name: shortText(),
	quantity: z.string().trim().max(40).optional(),
	unit: z.string().trim().max(40).optional(),
	note: z.string().trim().max(200).optional(),
});

const noteKind = z
	.enum(NOTE_KINDS)
	.describe(
		"preference: likes/dislikes; dietary: allergies, restrictions, goals; conversation: summary of a discussion with a cook bot; plan: meal plans; other",
	);

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// ---- server ----------------------------------------------------------------

/**
 * Build the MCP server for one request. Anonymous callers only see the two
 * tools that mint a token; members see everything scoped to their kitchen.
 */
export function createServer({ db, adminSecret }: ServerDeps, me: Member | undefined): McpServer {
	const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
	if (!me) registerAnonymousTools(server, db, adminSecret);
	else registerMemberTools(server, db, me);
	return server;
}

function registerAnonymousTools(server: McpServer, db: D1Database, adminSecret: string | undefined) {
	server.registerTool(
		"create_kitchen",
		{
			title: "Create kitchen",
			description:
				"Create a new shared kitchen and become its first member. Requires the server's admin secret (set by whoever deployed this server). Returns a bearer token, shown once.",
			inputSchema: z.object({
				admin_secret: z.string().min(1).max(500).describe("The server's KITCHEN_ADMIN_SECRET"),
				kitchen_name: shortText(100).describe('e.g. "Simon & Alex"'),
				display_name: shortText(60).describe("Your name as other members will see it"),
			}),
			annotations: WRITE,
		},
		(input) => run(() => kitchen.createKitchen(db, adminSecret, input)),
	);

	server.registerTool(
		"redeem_invite",
		{
			title: "Redeem invite",
			description:
				"Join a kitchen with a single-use invite code from an existing member. Returns your own bearer token, shown once.",
			inputSchema: z.object({
				code: z.string().min(4).max(40).describe('Invite code, e.g. "KTCH-7QX4-M9PB-2RZD" (case and dashes ignored)'),
				display_name: shortText(60).describe("Your name as other members will see it"),
			}),
			annotations: WRITE,
		},
		(input) => run(() => kitchen.redeemInvite(db, input)),
	);
}

function registerMemberTools(server: McpServer, db: D1Database, me: Member) {
	// ---- kitchen & members ----

	server.registerTool(
		"whoami",
		{
			title: "Who am I",
			description: "Show your kitchen, your member identity, and counts of recipes, open grocery items, and notes.",
			annotations: READ,
		},
		() => run(() => kitchen.whoami(db, me)),
	);

	server.registerTool(
		"invite_member",
		{
			title: "Invite member",
			description:
				"Create a single-use invite code for someone to join this kitchen (e.g. your partner). They redeem it with redeem_invite.",
			inputSchema: z.object({
				expires_in_minutes: z.number().int().min(5).max(10_080).default(60).describe("Default 60, max 7 days"),
			}),
			annotations: WRITE,
		},
		(input) => run(() => kitchen.inviteMember(db, me, input)),
	);

	server.registerTool(
		"list_members",
		{ title: "List members", description: "List current and revoked members of this kitchen.", annotations: READ },
		() => run(() => kitchen.listMembers(db, me)),
	);

	server.registerTool(
		"revoke_member",
		{
			title: "Revoke member",
			description: "Revoke another member's access. Their token stops working immediately. Their recipes and notes stay.",
			inputSchema: z.object({ member_id: id("Member") }),
			annotations: DESTRUCTIVE,
		},
		(input) => run(() => kitchen.revokeMember(db, me, input)),
	);

	server.registerTool(
		"rotate_token",
		{
			title: "Rotate token",
			description: "Replace your bearer token with a new one. The current token stops working immediately.",
			annotations: DESTRUCTIVE,
		},
		() => run(() => kitchen.rotateToken(db, me)),
	);

	// ---- recipes ----

	server.registerTool(
		"create_recipe",
		{
			title: "Create recipe",
			description: "Save a recipe to the shared kitchen.",
			inputSchema: z.object({ title: shortText(), ...partial(recipeFields) }),
			annotations: WRITE,
		},
		(input) => run(() => recipes.createRecipe(db, me, input)),
	);

	server.registerTool(
		"get_recipe",
		{
			title: "Get recipe",
			description: "Read one recipe with ingredients, steps, and who last changed it.",
			inputSchema: z.object({ id: id("Recipe") }),
			annotations: READ,
		},
		async (input) => run(async () => ({ recipe: await recipes.getRecipe(db, me, input.id) })),
	);

	server.registerTool(
		"update_recipe",
		{
			title: "Update recipe",
			description:
				"Change some fields of a recipe. Omitted fields are kept; null clears a field. Lists (ingredients, steps, tags) are replaced whole. Pass expected_version (from get_recipe) to avoid overwriting someone else's edit.",
			inputSchema: z.object({
				id: id("Recipe"),
				expected_version: z.number().int().min(1).optional(),
				title: shortText().optional(),
				...nullablePartial(recipeFields),
			}),
			annotations: { ...WRITE, idempotentHint: false },
		},
		(input) => run(() => recipes.updateRecipe(db, me, input)),
	);

	server.registerTool(
		"delete_recipe",
		{
			title: "Delete recipe",
			description: "Delete a recipe. Grocery items added from it stay on the list.",
			inputSchema: z.object({ id: id("Recipe") }),
			annotations: DESTRUCTIVE,
		},
		(input) => run(() => recipes.deleteRecipe(db, me, input)),
	);

	server.registerTool(
		"search_recipes",
		{
			title: "Search recipes",
			description:
				"Find recipes. query matches title, description, notes, tags, and ingredient names. With no filters, lists recently updated recipes.",
			inputSchema: z.object({
				query: z.string().trim().max(200).optional(),
				ingredient: z.string().trim().max(100).optional().describe("Only recipes using this ingredient"),
				tags: tags.optional().describe("Only recipes having all these tags"),
				limit,
			}),
			annotations: READ,
		},
		(input) => run(() => recipes.searchRecipes(db, me, input)),
	);

	// ---- grocery list ----

	server.registerTool(
		"list_grocery",
		{
			title: "List grocery list",
			description: "Show the shared grocery list, open items first.",
			inputSchema: z.object({ include_checked: z.boolean().default(true) }),
			annotations: READ,
		},
		(input) => run(() => grocery.listGrocery(db, me, input)),
	);

	server.registerTool(
		"add_grocery_items",
		{
			title: "Add grocery items",
			description: "Add one or more items to the shared grocery list.",
			inputSchema: z.object({ items: z.array(groceryItem).min(1).max(100) }),
			annotations: WRITE,
		},
		(input) => run(() => grocery.addGroceryItems(db, me, input)),
	);

	server.registerTool(
		"add_recipe_to_grocery",
		{
			title: "Add recipe to grocery list",
			description:
				"Add a recipe's ingredients to the grocery list. By default skips ingredients already open on the list (same name).",
			inputSchema: z.object({
				recipe_id: id("Recipe"),
				skip_existing: z.boolean().default(true),
				exclude: z.array(shortText()).max(200).optional().describe("Ingredient names you already have"),
			}),
			annotations: WRITE,
		},
		(input) => run(() => grocery.addRecipeToGrocery(db, me, input)),
	);

	server.registerTool(
		"check_grocery_items",
		{
			title: "Check grocery items",
			description: "Mark items as bought (checked: true, default) or put them back on the list (checked: false).",
			inputSchema: z.object({ ids: ids("Grocery item"), checked: z.boolean().default(true) }),
			annotations: { ...WRITE, idempotentHint: true },
		},
		(input) => run(() => grocery.setChecked(db, me, input)),
	);

	server.registerTool(
		"remove_grocery_items",
		{
			title: "Remove grocery items",
			description: "Delete items from the grocery list.",
			inputSchema: z.object({ ids: ids("Grocery item") }),
			annotations: DESTRUCTIVE,
		},
		(input) => run(() => grocery.removeGroceryItems(db, me, input)),
	);

	server.registerTool(
		"clear_checked_grocery",
		{
			title: "Clear checked grocery items",
			description: "Delete every checked item from the grocery list (e.g. after shopping).",
			annotations: DESTRUCTIVE,
		},
		() => run(() => grocery.clearChecked(db, me)),
	);

	// ---- context notes ----

	server.registerTool(
		"save_note",
		{
			title: "Save note",
			description:
				"Save a context note every member's assistant can read: a preference, a dietary need, a summary of a conversation with a cook bot, a plan. Pass id to edit an existing note.",
			inputSchema: z.object({
				id: id("Note").optional().describe("Edit this note instead of creating one"),
				kind: noteKind,
				subject: z.string().trim().max(100).optional().describe('Who or what it is about, e.g. "Alex", "weeknight dinners"'),
				content: z.string().trim().min(1).max(8000),
				tags: tags.optional(),
			}),
			annotations: WRITE,
		},
		(input) => run(() => notes.saveNote(db, me, input)),
	);

	server.registerTool(
		"search_notes",
		{
			title: "Search notes",
			description: "Find context notes, newest first. query matches content, subject, and tags. With no filters, lists recent notes.",
			inputSchema: z.object({
				query: z.string().trim().max(200).optional(),
				kind: noteKind.optional(),
				tags: tags.optional().describe("Only notes having all these tags"),
				author_id: id("Member").optional(),
				limit,
			}),
			annotations: READ,
		},
		(input) => run(() => notes.searchNotes(db, me, input)),
	);

	server.registerTool(
		"delete_note",
		{
			title: "Delete note",
			description: "Delete a context note.",
			inputSchema: z.object({ id: id("Note") }),
			annotations: DESTRUCTIVE,
		},
		(input) => run(() => notes.deleteNote(db, me, input)),
	);
}

// ---- helpers ---------------------------------------------------------------

type Shape = Record<string, z.ZodType>;

function partial<S extends Shape>(shape: S) {
	return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as {
		[K in keyof S]: z.ZodOptional<S[K]>;
	};
}

function nullablePartial<S extends Shape>(shape: S) {
	return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.nullable().optional()])) as {
		[K in keyof S]: z.ZodOptional<z.ZodNullable<S[K]>>;
	};
}
