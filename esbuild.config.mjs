import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['obsidian'],
  sourcemap: false,
  logLevel: 'info',
});
