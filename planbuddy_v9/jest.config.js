module.exports = {
  testEnvironment: 'node',

  rootDir: __dirname,

  testMatch: [
    '<rootDir>/__tests__/**/*.test.js',
    '<rootDir>/__tests__/**/*.spec.js'
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/.vscode/',
    '/.codex/',
  ],

  moduleDirectories: ['node_modules', '<rootDir>'],

  moduleNameMapper: {
    '^config/(.*)$': '<rootDir>/config/$1'
  },

  maxWorkers: 1,
  testTimeout: 30000
};
