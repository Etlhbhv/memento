import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, run `memento ui --port 4321` and set MEMENTO_API to proxy the API.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": process.env.MEMENTO_API ?? "http://127.0.0.1:4321" } },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
});
