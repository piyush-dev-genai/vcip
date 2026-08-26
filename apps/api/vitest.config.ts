import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
  // NestJS relies on emitDecoratorMetadata, which esbuild (Vitest's default
  // transformer) does not emit. SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
