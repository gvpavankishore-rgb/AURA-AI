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
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: backend,
          changeOrigin: true,
        },
        '/uploads': {
          target: backend,
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            markdown: ['react-markdown', 'remark-gfm', 'react-syntax-highlighter'],
          },
        },
      },
    },
  }
})