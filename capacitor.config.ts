import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.n0thytvoff.prepatrack',
  appName: 'PrepaTrack',
  webDir: 'dist',
  backgroundColor: '#0b0f14',
  ios: {
    backgroundColor: '#0b0f14',
    contentInset: 'always',
    preferredContentMode: 'mobile',
  },
}

export default config
