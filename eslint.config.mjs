import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
    globalIgnores(['**/node_modules/**', 'dist/**', 'tmp/**', 'out-tsc/**', '.cursor/**', '.idea/**']),
    {
        files: ['**/*.{js,mjs,cjs,ts}'],
        extends: [js.configs.recommended],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['**/*.ts'],
        extends: [tseslint.configs.recommended],
    },
    {
        files: ['src/types.ts'],
        // Store implementations may return arbitrary write/delete results; the cache ignores them.
        rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
    {
        files: ['test/**/*.types-check.ts'],
        // Negative export checks intentionally import names without using them.
        rules: { '@typescript-eslint/no-unused-vars': 'off' },
    },
    prettier,
);
