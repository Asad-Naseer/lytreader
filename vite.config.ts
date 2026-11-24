import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',

      includeAssets: ['apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],

      manifest: {
        name: 'LytReader',
        short_name: 'LytReader',
        description: 'Offline EPUB reader.',
        theme_color: '#1c1c1c',
        background_color: '#1c1c1c',
        display: 'standalone',
        scope: '/lytreader/',
        start_url: '/lytreader/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },

      workbox: {
        maximumFileSizeToCacheInBytes: 10000000, // 10MB limit for epub.js and react
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // Don't try to cache Dropbox API or file content sync calls
            urlPattern: /^https:\/\/(api|content)\.dropboxapi\.com\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    allowedHosts: ['.trycloudflare.com'],
  },
  base: '/lytreader/',
})