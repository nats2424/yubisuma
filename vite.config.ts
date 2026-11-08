/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // GitHub Pages などサブパスに置く場合は VITE_BASE=/yubisuma/ のように指定する
  base: loadEnv(mode, '.', '').VITE_BASE || '/',
  // エージェント用の git worktree（.claude/worktrees）内のテストを拾わない
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
}));
