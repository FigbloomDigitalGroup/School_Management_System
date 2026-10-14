/**
 * FIG-782: injected at bundle time from apps/teacher-mobile/.env via
 * react-native-dotenv (babel.config.js), not hardcoded. .env is gitignored —
 * copy .env.example and fill it in from the same Supabase project as the
 * web app's VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
 */
import { SUPABASE_URL as _SUPABASE_URL, SUPABASE_ANON_KEY as _SUPABASE_ANON_KEY } from "@env";

export const SUPABASE_URL = _SUPABASE_URL;
export const SUPABASE_ANON_KEY = _SUPABASE_ANON_KEY;
