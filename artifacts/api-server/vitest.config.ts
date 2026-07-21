import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Vitest runs with the test process's real env, so OPENAI_API_KEY may be
    // absent. The mock factories in the test files prevent any real imports.
    setupFiles: [],
  },
  resolve: {
    alias: {
      // Redirect workspace packages so vi.mock() factories can intercept them
      // before the real modules (which require DB/API keys) are loaded.
      "@workspace/db": resolve("../../lib/db/src/index.ts"),
      "@workspace/integrations-openai-ai-server": resolve(
        "../../lib/integrations-openai-ai-server/src/index.ts",
      ),
      "@workspace/api-zod": resolve("../../lib/api-zod/src/index.ts"),
    },
  },
});
