import { defineConfig } from "vitest/config";

// Kertel runs its suite against the TypeScript sources, not a build output, so
// a failing test points at the file you edit. Fixture mode is the default and
// no test is allowed to reach the network.
export default defineConfig({
  // The workspace packages export two faces: `kertel-source` points at the
  // TypeScript, and the default points at the emitted JavaScript that Node and
  // OpenClaw load. Preferring the source condition here keeps the rule below
  // true -- a failing test points at the file you edit, not at a build output.
  resolve: { conditions: ["kertel-source"] },
  ssr: { resolve: { conditions: ["kertel-source"] } },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
