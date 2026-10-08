import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist/web', emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // React Server Component markers have no effect in this client-only SPA.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
        warn(warning);
      },
      output: {
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (id.includes('/node_modules/@mantine/') || id.includes('/node_modules/@floating-ui/')) return 'ui';
        },
      },
    },
  },
});
