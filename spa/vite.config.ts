import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { spaOutDir } from '../scripts/sma/lib/spa-dist.mjs'

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
 *
 * …UNLESS SOMEBODY NAMES A STAGING DIRECTORY. `emptyOutDir` wipes the output BEFORE the
 * first file is written, so a build that dies halfway leaves the served directory EMPTY —
 * the window disappears, and every guard around it reads that as «nothing to compare».
 * `SMA_SPA_OUT_DIR` lets the caller build into a scratch directory and swap it into place
 * only once the build has actually succeeded (scripts/sma/lib/spa-dist.mjs, which is what
 * `npm run build:spa` runs). The command a person types stays the same one; without the
 * variable this config behaves exactly as it always did.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: spaOutDir(),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
})
