'use strict';

const js = require('@eslint/js');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'coverage/**'
        ]
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                Buffer: 'readonly',
                URL: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                console: 'readonly',
                process: 'readonly',
                setImmediate: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly'
            }
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error'
        },
        rules: {
            curly: ['error', 'all'],
            eqeqeq: ['error', 'always'],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}]
        }
    }
];
