// The theme (src/ui/ThemeContext.tsx) and the offline queue keep their settings in AsyncStorage, a native module that does
// not exist under Jest: the package ships an in-memory stand-in for exactly this.
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
