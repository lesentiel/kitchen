import { describe, expect, it } from "vitest";
import { call, callError, createCouple } from "./helpers.ts";

describe("context notes", () => {
	it("save, search by text/kind/tag/author, edit, delete", async () => {
		const { a, b } = await createCouple();
		const { note: allergy, created } = await call(a.client, "save_note", {
			kind: "dietary",
			subject: "Alex",
			content: "Allergic to peanuts. Tree nuts are fine.",
			tags: ["Allergy"],
		});
		expect(created).toBe(true);
		expect(allergy).toMatchObject({ kind: "dietary", tags: ["allergy"], author: { display_name: "Alex" } });
		expect(allergy.created_at).toBe(allergy.updated_at);

		await call(b.client, "save_note", {
			kind: "conversation",
			content: "Talked with the cook bot about weeknight dinners under 30 minutes.",
			tags: ["weeknight"],
		});

		const search = async (args: Record<string, unknown>) =>
			(await call(b.client, "search_notes", args)).notes.map((n: { content: string }) => n.content);

		expect(await search({})).toHaveLength(2);
		expect(await search({ query: "peanut" })).toEqual([allergy.content]);
		expect(await search({ query: "alex" })).toEqual([allergy.content]); // subject
		expect(await search({ kind: "conversation" })).toHaveLength(1);
		expect(await search({ tags: ["ALLERGY"] })).toEqual([allergy.content]);
		expect(await search({ author_id: b.memberId })).toHaveLength(1);

		const edited = await call(b.client, "save_note", {
			id: allergy.id,
			kind: "dietary",
			subject: "Alex",
			content: "Allergic to peanuts and cashews.",
			tags: ["allergy"],
		});
		expect(edited.created).toBe(false);
		expect(edited.note.author.display_name).toBe("Alex"); // original author kept
		expect(edited.note.updated_at >= allergy.updated_at).toBe(true);

		await call(a.client, "delete_note", { id: allergy.id });
		expect(await search({ query: "peanut" })).toEqual([]);
		await callError(a.client, "delete_note", { id: allergy.id });
	});

	it("validates kind", async () => {
		const { a } = await createCouple();
		const res = await a.client.callTool({ name: "save_note", arguments: { kind: "gossip", content: "x" } });
		expect(res.isError).toBe(true);
	});
});
