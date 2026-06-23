import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: 'src/client',
  publicDir: '../../public',
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/stream': {
        target: 'ws://localhost:3000',
        ws: true
      }
    }
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'favicon-64.png'],
      manifest: false, // 使用 public/manifest.json 外部文件
      workbox: {
        globPatterns: ['**/*.{js,css,html,mp3,wav,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.(mp3|wav)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'audio-cache', expiration: { maxEntries: 50, maxAgeSeconds: 86400 * 7 } }
          }
        ]
      }
    })
  ]
});
