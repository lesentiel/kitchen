import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: ({ mode }) => ({
		name: "kitchen",
		// Capped by the workerd bundled with @cloudflare/vitest-pool-workers 0.22
		// (supports up to 2026-08-22). Keep in sync with vitest.config.ts.
		compatibilityDate: "2026-08-15",
		entrypoint,
		env: {
			// Provisioned by `cf deploy` on first deploy. The Worker applies
			// migrations/*.sql itself (src/migrate.ts).
			DB: bindings.d1({ name: "kitchen" }),
			// Required to call create_kitchen. Locally: .dev.vars.
			KITCHEN_ADMIN_SECRET: bindings.secret(),
		},
		// The intended production domain is only attached with
		// `cf deploy --mode lesentiel`, so a self-hoster's plain `cf deploy` (or
		// Deploy button) doesn't try to claim a zone it doesn't own. Self-hosters:
		// add your own mode and domain here, or stay on workers.dev.
		domains: mode === "lesentiel" ? ["kitchen.lesentiel.com"] : [],
		observability: { enabled: true },
	}),
});
