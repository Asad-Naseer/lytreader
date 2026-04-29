import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins:[
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      
      // 1. THIS IS THE MAGIC LINE: 
      // Setting manifest to false stops the browser from treating it as an installable PWA.
      manifest: false, 
      
      // 2. We keep the Workbox config because this is what actually handles the offline caching.
      workbox: {
        maximumFileSizeToCacheInBytes: 10000000, // 10MB limit for epub.js and react
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        navigateFallback: '/index.html',
        runtimeCaching:[
          {
            // Don't try to cache Dropbox sync API calls
            urlPattern: /^https:\/\/api\.dropboxapi\.com\/.*/i,
            handler: 'NetworkOnly',
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