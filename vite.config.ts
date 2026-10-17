import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The same bundle serves the installed app (packaged assets) and a browser
// (served by the household server). There is no service worker: packaged
// assets change only with application releases, and a cached shell must never
// look like a working offline browser.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        legacyExport: resolve(__dirname, 'legacy-export.html'),
      },
    },
  },
});
