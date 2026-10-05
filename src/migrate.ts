// Applies migrations/*.sql from inside the Worker.
//
// Why: `cf deploy` (and the Deploy to Cloudflare button) auto-provision the D1
// database but do not write its ID back to the config, and
// `cf d1 migrations apply` only accepts a database ID. Running migrations from
// the Worker makes a fresh deploy usable with no extra step.
//
// Compatible with `cf d1 migrations apply`: same `d1_migrations` table shape,
// same recorded names (the file name), applied in file-name order.

const files = import.meta.glob<string>("../migrations/*.sql", {
	query: "?raw",
	import: "default",
	eager: true,
});

export const MIGRATIONS = Object.entries(files)
	.map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql }))
	.sort((a, b) => a.name.localeCompare(b.name));

/**
 * Split a migration file into statements. Our migrations contain no triggers
 * and no semicolons inside string literals, so a plain split is enough.
 */
export function splitStatements(sql: string): string[] {
	return sql
		.replace(/--.*$/gm, "")
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
}

let applied: Promise<void> | undefined;

/** Run pending migrations once per isolate. */
export function ensureMigrated(db: D1Database): Promise<void> {
	const pending = (applied ??= migrate(db).then(
		() => {},
		(err) => {
			applied = undefined; // retry on the next request
			throw err;
		},
	));
	return pending;
}

export async function migrate(db: D1Database): Promise<string[]> {
	await db
		.prepare(
			"CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
		)
		.run();
	const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
	const done = new Set(results.map((r) => r.name));
	const ran: string[] = [];
	for (const m of MIGRATIONS) {
		if (done.has(m.name)) continue;
		// One batch = one transaction. If another isolate applied the same
		// migration concurrently, the UNIQUE insert fails and the batch rolls back.
		try {
			await db.batch([
				...splitStatements(m.sql).map((s) => db.prepare(s)),
				db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name),
			]);
			ran.push(m.name);
		} catch (err) {
			const row = await db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").bind(m.name).first();
			if (!row) throw err;
		}
	}
	return ran;
}
