import { MAX_FILE_BYTES } from "@figbloom/shared";

/**
 * The largest file the hosted project will take. Supabase's project-wide
 * upload limit (Dashboard -> Storage -> Settings) caps every upload whatever
 * the bucket allows: 50 MB on the free plan. Set VITE_MAX_UPLOAD_MB to match
 * it so a too-big file is refused with a clear message before any of it is
 * sent, instead of failing partway. Never above the bucket's own 2 GB.
 */
const configured = Number(import.meta.env.VITE_MAX_UPLOAD_MB);
export const UPLOAD_LIMIT_BYTES = Math.min(
  (Number.isFinite(configured) && configured > 0 ? configured : 50) * 1024 ** 2,
  MAX_FILE_BYTES,
);
