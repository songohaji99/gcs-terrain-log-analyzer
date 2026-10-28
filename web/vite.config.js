import { defineConfig } from 'vite';

// Proxy API publik agar bebas masalah CORS (berlaku untuk `dev` maupun `preview`).
const proxy = {
  '/api/pb': { target: 'https://data.petabencana.id', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/pb/, '') },
  '/api/bmkg': { target: 'https://api.bmkg.go.id', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/bmkg/, '') },
  '/api/gempa': { target: 'https://data.bmkg.go.id', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/gempa/, '') },
};

export default defineConfig({
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
