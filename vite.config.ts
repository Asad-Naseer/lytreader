import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins:[
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true // <--- ADD THIS LINE
      },
      workbox: {
        globPatterns:['**/*.{js,css,html,ico,png,svg}']
      },
      includeAssets:['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Lytreader',
        short_name: 'Lytreader',
        description: 'An elegant reading app',
        theme_color: '#1e1e2e',
        background_color: '#1e1e2e',
        display: 'standalone',
        icons:[
          {
            // Note: because you have base: '/lytreader/', we omit the leading slash
            // so it resolves correctly on GitHub Pages
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
  server: {
    allowedHosts: ['.trycloudflare.com']
  },
  base: '/lytreader/',
})