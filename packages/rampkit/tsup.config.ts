import { defineConfig, type Options } from 'tsup';

const shared: Options = {
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'es2022',
    outDir: 'dist',
};

export default defineConfig([
    // `clean` only on the first config — later configs would wipe earlier output.
    { ...shared, clean: true, entry: { index: 'src/index.ts' } },
    { ...shared, entry: { 'server/index': 'src/server/index.ts' } },
    { ...shared, entry: { 'client/index': 'src/client/index.ts' } },
    {
        ...shared,
        entry: { 'react/index': 'src/react/index.tsx' },
        external: ['react'],
        // React client components: the directive must survive bundling.
        banner: { js: '"use client";' },
    },
]);
