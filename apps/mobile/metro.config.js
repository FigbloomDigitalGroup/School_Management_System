const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */

// npm workspaces monorepo: node_modules is hoisted to the repo root, two
// levels above this app. Metro's default resolver doesn't walk up that far
// on its own — it needs to be told about both locations explicitly, and to
// watch the root so changes to @figbloom/shared (also hoisted) are picked up.
const monorepoRoot = path.resolve(__dirname, '../..');

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    // react-native-screens is pinned to 4.5.0 here (package.json), but also
    // sits hoisted at the repo root as a newer peer dependency for some
    // other workspace — Node's upward resolution from a nested importer
    // (e.g. @react-navigation/*, itself hoisted to root) finds that root
    // copy first and pulls in TS component specs this RN version's codegen
    // can't parse. extraNodeModules doesn't help here: it's only a
    // fallback for names that fail to resolve, and this one already
    // resolves (just to the wrong copy) — resolveRequest is the one hook
    // that overrides resolution unconditionally.
    //
    // react-native-svg is the same story at runtime: this app pins 15.8.0 (the
    // native side that gets built), but lucide-react-native, hoisted at the
    // root, asks for ^15.15.5 and gets that copy. Two JS copies register the
    // same native views, and the app dies with "Tried to register two views
    // with the same name RNSVGCircle" as soon as our own code imports it too.
    resolveRequest: (context, moduleName, platform) => {
      for (const pinned of ['react-native-screens', 'react-native-svg']) {
        if (moduleName === pinned || moduleName.startsWith(pinned + '/')) {
          const rest = moduleName.slice(pinned.length);
          return context.resolveRequest(
            context,
            path.resolve(__dirname, 'node_modules/' + pinned + rest),
            platform,
          );
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
