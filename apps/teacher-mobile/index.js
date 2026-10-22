/**
 * @format
 */

// Must be the first import: React Native's built-in URL implementation
// doesn't implement .protocol (throws "URL.protocol is not implemented"),
// which @supabase/supabase-js needs. This replaces the global with a
// spec-compliant one before anything else — including Supabase client
// creation in ./src/lib/client — runs.
import 'react-native-url-polyfill/auto';

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
