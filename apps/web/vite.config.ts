import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/health": "http://127.0.0.1:3000",
      "/projects": "http://127.0.0.1:3000",
      "/settings": "http://127.0.0.1:3000",
      "/tasks": "http://127.0.0.1:3000",
      "/ai": "http://127.0.0.1:3000",
    },
  },
});
