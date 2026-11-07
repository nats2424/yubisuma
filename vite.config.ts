import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // GitHub Pages などサブパスに置く場合は VITE_BASE=/yubisuma/ のように指定する
  base: loadEnv(mode, '.', '').VITE_BASE || '/',
}));
