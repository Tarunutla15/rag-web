import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/chat': 'http://127.0.0.1:8000',
      '/agent': 'http://127.0.0.1:8000',
      '/upload': 'http://127.0.0.1:8000',
      '/sessions': 'http://127.0.0.1:8000',
      '/documents': 'http://127.0.0.1:8000',
      '/dashboard': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
    },
  },
})
