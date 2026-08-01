import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The window is a STATIC bundle. It never becomes a server.
 *
 * A relative base — every asset reference in the built index.html stays relative, so the
 * bundle works from whatever mount point the daemon happens to serve it at, and the
 * daemon's flat `/assets/<file>` route can hand the files back one by one.
 *
 * `outDir: ../daemon/static/app` — the build lands where the daemon already looks for
 * static files, behind the same token gate as every other route. The directory is
 * ignored by git: a release builds it, a repository never carries it.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: '../daemon/static/app',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
})
