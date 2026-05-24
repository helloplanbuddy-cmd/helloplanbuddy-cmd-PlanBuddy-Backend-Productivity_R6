module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/*.test.js"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/.vscode/",
    "/.codex/",
    "/dist/",
    "/build/"
  ]
};