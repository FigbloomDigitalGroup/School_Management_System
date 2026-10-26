interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_APP_NAME: string;
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  /** Largest upload in MB the hosted project accepts (Dashboard -> Storage -> Settings). Default 50. */
  readonly VITE_MAX_UPLOAD_MB?: string;
  /** Set by Vite: true under `vite` dev, false in `vite build`. */
  readonly DEV: boolean;
}
interface ImportMeta { readonly env: ImportMetaEnv }
