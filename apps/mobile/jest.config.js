/**
 * Jest for the parent, student and driver app: `npm test` inside apps/mobile.
 * The React Native preset supplies the native-module mocks. The libraries it names and the shared workspace package are
 * not plain JavaScript (untranspiled modules, TypeScript source), so they must go through Babel like our own files.
 */
module.exports = {
  preset: "react-native",
  setupFiles: ["<rootDir>/jest.setup.js"],
  testMatch: ["<rootDir>/src/**/*.test.{ts,tsx}"],
  // src/ui holds plain-Node helpers tested with Vitest from the repo root (npm run test:unit), not Jest
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/src/ui/"],
  transformIgnorePatterns: ["node_modules/(?!((jest-)?react-native|@react-native(-community)?|@figbloom)/)"],
};
