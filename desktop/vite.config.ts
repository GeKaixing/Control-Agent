import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * 渲染层构建配置：根目录在 desktop/renderer，产出 desktop/renderer-dist。
 * dev 时由 electron 主进程通过 loadURL("http://127.0.0.1:5173") 拉取。
 */
export default defineConfig({
  root: "desktop/renderer",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "../renderer-dist",
    emptyOutDir: true,
  },
});
