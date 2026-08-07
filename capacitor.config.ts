import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.n0thytvoff.prepatrack',
  appName: 'PrepaTrack',
  webDir: 'dist',
  backgroundColor: '#0b0f14',
  ios: {
    backgroundColor: '#0b0f14',
    // Le WKWebView occupe tout l'écran. React réserve lui-même les safe areas :
    // laisser UIKit ajouter aussi ses insets créait une seconde bande sous la
    // navigation sur les iPhone avec indicateur d'accueil.
    contentInset: 'never',
    preferredContentMode: 'mobile',
  },
}

export default config
