import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// `npm run build` writes the dashboard into the controller's build, controller/dist/dashboard, which
// the controller serves at its root. `npm run dev` serves it with hot reload and sends every API call to
// a controller started beside it on its default address (`node controller/dist/main.js --fake`).
// changeOrigin sends the controller's own address as the Host, which is the only Host it answers, so
// the dev server answers no preflight: a page on another local port cannot write through the proxy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  build: { outDir: "../controller/dist/dashboard", emptyOutDir: true },
  server: { cors: false, proxy: { "/api": { target: "http://127.0.0.1:7420", changeOrigin: true } } },
})
