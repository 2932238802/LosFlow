import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "./",
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:8899",
      "/events": "http://127.0.0.1:8899",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
