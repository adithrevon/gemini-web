/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:7337',
        ws: true,
        changeOrigin: true,
      },
    },
    allowedHosts: ['prems-mac-mini.tailcb69a0.ts.net'],
  },
  build: {
    outDir: 'dist',
  },
});
