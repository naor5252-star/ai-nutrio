import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist/client" },
  preview: { host: "127.0.0.1", port: 4173 },
});
