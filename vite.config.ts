import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

const buildTime = new Date().toISOString()
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  .version as string

export default defineConfig({
  // Horodatage du build, affiché dans le diagnostic : c'est le seul moyen de
  // savoir à distance si l'appareil exécute bien la dernière version, ou une
  // ancienne encore servie par le service worker.
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    {
      name: 'prepatrack-build-version',
      generateBundle() {
        // Ce fichier n'est volontairement pas précaché : il décrit la version
        // disponible sur le serveur, pas celle que le service worker actif sert.
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ version: appVersion, buildTime }),
        })
      },
    },
    VitePWA({
      // La nouvelle version est téléchargée et installée en attente. Seule une
      // confirmation explicite, hors vacation, lui permet ensuite de prendre
      // le contrôle et de recharger l'application.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PrepaTrack',
        short_name: 'PrepaTrack',
        description: 'Suivi de production preparateur de commandes',
        // Même teinte que la barre d'onglets : sur iOS, la bande située hors
        // du viewport de l'app installée est peinte par le système à partir de
        // ces couleurs, et non par un élément de la page.
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
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
        // Jamais d'activation ni de remplacement du contrôleur au milieu d'une
        // vacation. `registerType: prompt` enverra SKIP_WAITING uniquement après
        // l'action explicite de l'utilisateur.
        skipWaiting: false,
        clientsClaim: false,
      },
    }),
  ],
})
