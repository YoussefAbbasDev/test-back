const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup-env.js'],
    globalSetup: ['tests/global-setup.js'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
