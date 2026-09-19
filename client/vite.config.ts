import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Everything under /api goes to the Express server so the browser only
      // ever talks to one origin in development.
      // "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/api": {
        target: "https://digital-families.onrender.com",
        changeOrigin: true,
      },
    },
  },
});
