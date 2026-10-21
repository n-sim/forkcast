import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The same bundle serves the installed app (packaged assets) and a browser
// (served by the household server). There is no service worker: packaged
// assets change only with application releases, and a cached shell must never
// look like a working offline browser.

// The calculation engine is fetched by the bundle once it runs. Announcing it
// in the page lets it download alongside the bundle instead of after it.
function preloadDomainEngine(): Plugin {
  return {
    name: 'forkcast-preload-domain-engine',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }) {
        return Object.keys(bundle ?? {})
          .filter((file) => /forkcast_recipe_domain_bg.*\.wasm$/.test(file))
          .map((file) => ({
            tag: 'link',
            attrs: {
              rel: 'preload',
              href: `/${file}`,
              as: 'fetch',
              type: 'application/wasm',
              crossorigin: '',
            },
            injectTo: 'head' as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadDomainEngine()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        legacyExport: resolve(__dirname, 'legacy-export.html'),
      },
    },
  },
});
