import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const backendUrl = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 3000,
    // Cookie-auth CORS permits this exact development origin. Failing fast is
    // safer than silently moving to an unlisted port and breaking credentials.
    strictPort: true,
    proxy: {
      "/api": backendUrl,
      "/admin": backendUrl,
    },
  },
  preview: {
    port: 3000,
    strictPort: false,
  },
});
