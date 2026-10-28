interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_APP_NAME: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  /** Largest upload in MB the hosted project accepts (Dashboard -> Storage -> Settings). Default 50. */
  readonly VITE_MAX_UPLOAD_MB?: string;
  /** Google Drive for Bloom (lib/googleDrive.ts): all three, or Drive stays hidden. */
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly VITE_GOOGLE_PICKER_API_KEY?: string;
  readonly VITE_GOOGLE_CLOUD_PROJECT_NUMBER?: string;
  /** Set by Vite: true under `vite` dev, false in `vite build`. */
  readonly DEV: boolean;
}
interface ImportMeta { readonly env: ImportMetaEnv }

/** A file Vite copies into the build, imported as its URL (`import url from "./font.ttf?url"`). */
declare module "*?url" {
  const url: string;
  export default url;
}
