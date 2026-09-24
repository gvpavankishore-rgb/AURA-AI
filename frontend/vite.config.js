import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Dev proxy target. Defaults to the LOCAL backend (localhost:5001) so
  // frontend development exercises the code in this repo. To proxy against a
  // deployed backend instead, set VITE_BACKEND_URL in frontend/.env.
  const backend = env.VITE_BACKEND_URL || 'http://localhost:5001'

  return {
    plugins: [react()],
    // Assets are served from the domain root on Render's static CDN, so the
    // base must stay '/'. Changing this causes 404s for the built JS/CSS.
    base: '/',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: true,
          secure: false,
        },
        '/uploads': {
          target: backend,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (/[\\/](react|react-dom|react-router|react-router-dom)(?:[\\/]|$)/.test(id)) return 'vendor';
            }
            return undefined;
          },
        },
      },
    },
  }
})