// End-to-end sample session against a running server (default: `pnpm dev`).
//
//   KITCHEN_ADMIN_SECRET=... node scripts/sample-session.ts [http://localhost:5173/mcp]
//
// Creates a kitchen as Alex, invites Sam, redeems the invite as Sam, adds a
// recipe and groceries as Alex, saves a note as Alex, then reads it all back
// as Sam.
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://localhost:5173/mcp");
const adminSecret = process.env.KITCHEN_ADMIN_SECRET ?? readDevVar("KITCHEN_ADMIN_SECRET");

function readDevVar(name: string): string {
	const line = readFileSync(".dev.vars", "utf8")
		.split("\n")
		.find((l) => l.startsWith(`${name}=`));
	if (!line) throw new Error(`Set ${name} or add it to .dev.vars`);
	return line.slice(name.length + 1).trim();
}

async function connect(token?: string) {
	const client = new Client({ name: "kitchen-sample-session", version: "0.1.0" });
	await client.connect(
		new StreamableHTTPClientTransport(url, {
			requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
		}),
	);
	return client;
}

// biome-ignore lint: loosely typed JSON
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
	const res = await client.callTool({ name, arguments: args });
	if (res.isError) throw new Error(`${name}: ${JSON.stringify(res.content)}`);
	console.log(`✓ ${name}`);
	return res.structuredContent;
}

const anon = await connect();
console.log("anonymous tools:", (await anon.listTools()).tools.map((t) => t.name).join(", "));

const created = await call(anon, "create_kitchen", {
	admin_secret: adminSecret,
	kitchen_name: `Sample ${new Date().toISOString().slice(0, 16)}`,
	display_name: "Alex",
});
const alex = await connect(created.token);

const { invite } = await call(alex, "invite_member", { expires_in_minutes: 15 });
console.log("  invite code:", invite.code);

const joined = await call(await connect(), "redeem_invite", { code: invite.code, display_name: "Sam" });
const sam = await connect(joined.token);

const { recipe } = await call(alex, "create_recipe", {
	title: "Weeknight Dal",
	servings: 4,
	ingredients: [
		{ name: "Red lentils", quantity: "1", unit: "cup" },
		{ name: "Onion", quantity: "1" },
		{ name: "Coconut milk", quantity: "1", unit: "can" },
	],
	steps: ["Soften onion", "Add lentils and 3 cups water, simmer 20 min", "Stir in coconut milk"],
	tags: ["dinner", "vegetarian"],
});
await call(alex, "add_recipe_to_grocery", { recipe_id: recipe.id });
await call(alex, "add_grocery_items", { items: [{ name: "Limes", quantity: "2" }] });
await call(alex, "save_note", {
	kind: "dietary",
	subject: "Alex",
	content: "Alex is allergic to peanuts.",
	tags: ["allergy"],
});

console.log("\n--- read back as Sam ---");
const me = await call(sam, "whoami");
console.log(`  ${me.me.display_name} in "${me.kitchen.name}":`, me.counts);
const found = await call(sam, "search_recipes", { query: "dal" });
console.log("  recipes:", found.recipes.map((r: { title: string }) => r.title));
const list = await call(sam, "list_grocery", {});
console.log("  grocery:", list.items.map((i: { name: string; added_by: string }) => `${i.name} (by ${i.added_by})`));
const { notes } = await call(sam, "search_notes", { kind: "dietary" });
console.log("  notes:", notes.map((n: { content: string; author: { display_name: string } }) => `${n.content} (by ${n.author.display_name})`));

if (notes[0]?.content !== "Alex is allergic to peanuts." || notes[0].author.display_name !== "Alex") {
	throw new Error("Sam could not read Alex's note");
}
console.log("\nSample session OK.");
