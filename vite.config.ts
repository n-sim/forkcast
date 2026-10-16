import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: false,
      workbox: {
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,wasm,svg,gz}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
});
