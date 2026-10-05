import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd via the Workers Vitest pool. The pool reads Wrangler
// config or inline Miniflare options, not cloudflare.config.ts, so the bindings
// are mirrored here. Keep them in sync with cloudflare.config.ts.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			miniflare: {
				compatibilityDate: "2026-08-15",
				d1Databases: ["DB"],
				// Matches ADMIN_SECRET in test/helpers.ts.
				bindings: { KITCHEN_ADMIN_SECRET: "test-admin-secret" },
			},
		}),
	],
});
