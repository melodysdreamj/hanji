import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const backendUrl = "http://localhost:8787";
const legalArtifactNames = ["LICENSE", "LICENSE-EXCEPTION", "SOURCE-OFFER"] as const;

function legalArtifactsPlugin(): Plugin {
  return {
    name: "hanji-legal-artifacts",
    apply: "build",
    closeBundle() {
      for (const name of legalArtifactNames) {
        copyFileSync(resolve(__dirname, "..", name), resolve(__dirname, "dist", name));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), legalArtifactsPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
    // Linked EdgeBase resolves its optional Yjs peer through its own pnpm
    // workspace unless the consumer explicitly dedupes it. One module identity
    // is required for Y.Doc constructors and keeps local-link behavior equal to
    // the registry consumer build.
    dedupe: ["yjs"],
  },
  build: {
    // The service-worker precache generator follows the emitted language
    // chunks through this manifest so first-load offline boot is complete.
    manifest: true,
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
