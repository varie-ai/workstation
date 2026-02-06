import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'release'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/main/llm/**'],
      exclude: ['node_modules/', 'dist/', 'tests/'],
    },
  },
});
