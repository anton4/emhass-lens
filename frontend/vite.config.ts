import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Version shown in the header and compared with /api/version to offer a reload after an update.
const version = process.env.BUILD_VERSION || 'dev'

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the UI is served under Home Assistant Ingress (/api/hassio_ingress/<token>/)
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    // Local dev: forward API calls to the backend (python -m emhass_lens on :8099)
    proxy: { '/api': 'http://localhost:8099' },
  },
})
