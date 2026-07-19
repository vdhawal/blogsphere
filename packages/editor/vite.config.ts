import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API port can be overridden so Playwright can spin up an isolated server.
const apiPort = process.env.BLOGSPACE_API_PORT ?? "4317";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.BLOGSPACE_EDITOR_PORT ?? 4318),
    proxy: {
      // Use 127.0.0.1 explicitly — Node sometimes resolves `localhost` to
      // ::1 first, and the server only binds to IPv4.
      "/api": `http://127.0.0.1:${apiPort}`,
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
