import { defineConfig } from 'vite';

export default defineConfig({
  // In dev, the game server runs separately (npm run server); proxy its WebSocket.
  server: { host: true, port: 5173, proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } } },
  build: { target: 'es2022' },
});
