import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@figbloom/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // .env lives at the monorepo root (see .env.example there), not in apps/web.
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  server: { port: 5173 },
});
