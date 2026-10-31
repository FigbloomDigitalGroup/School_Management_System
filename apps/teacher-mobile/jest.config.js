/**
 * Jest for the teacher app: `npm test` inside apps/teacher-mobile.
 * The React Native preset supplies the native-module mocks. The libraries it names and the shared workspace package are
 * not plain JavaScript (untranspiled modules, TypeScript source), so they must go through Babel like our own files.
 */
module.exports = {
  preset: "react-native",
  testMatch: ["<rootDir>/src/**/*.test.{ts,tsx}"],
  transformIgnorePatterns: ["node_modules/(?!((jest-)?react-native|@react-native(-community)?|@figbloom)/)"],
};
