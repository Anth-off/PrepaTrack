import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Horodatage du build, affiché dans le diagnostic : c'est le seul moyen de
  // savoir à distance si l'appareil exécute bien la dernière version, ou une
  // ancienne encore servie par le service worker.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PrepaTrack',
        short_name: 'PrepaTrack',
        description: 'Suivi de production preparateur de commandes',
        // Noir pur : la bande que le système laisse sous une app installée est
        // noire, ces couleurs doivent s'y accorder.
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'fr',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Tout l'applicatif est precache : l'app doit demarrer en mode avion.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        // Une app installée peut servir sa version en cache pendant des jours,
        // même après un déploiement : la nouvelle attend que toutes les
        // instances soient fermées. Ces deux options la font prendre la main
        // immédiatement, sinon un correctif reste invisible sans qu'on sache
        // pourquoi.
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
})
