import type { Config } from "tailwindcss";
import { brand, status, surface, appSurface } from "../../packages/shared/src/tokens";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        forest: brand.forest,
        "forest-deep": brand.forestDeep,
        leaf: brand.leaf,
        orange: brand.orange,
        "orange-soft": brand.orangeSoft,
        "orange-line": brand.orangeLine,
        "orange-ink": brand.orangeInk,
        ok: { bg: status.okBg, ink: status.okInk, dot: status.okDot },
        warn: { bg: status.warnBg, ink: status.warnInk, dot: status.warnDot },
        info: { bg: status.infoBg, ink: status.infoInk },
        page: surface.page,
        sunken: surface.sunken,
        line: surface.line,
        "line-soft": surface.lineSoft,
        ink: surface.ink,
        "ink-muted": surface.inkMuted,
        "ink-faint": surface.inkFaint,
        app: { page: appSurface.page, shell: appSurface.shell, line: appSurface.line, "line-soft": appSurface.lineSoft, ink: appSurface.ink, muted: appSurface.inkMuted, faint: appSurface.inkFaint },
        /** the tenant's own accent, set as a CSS variable by TenantThemeProvider */
        accent: "var(--accent)",
        "accent-deep": "var(--accent-deep)",
      },
      fontFamily: {
        sans: ["Figtree", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        micro: ["10px", "1.3"],
        mono: ["11px", "1.4"],
        small: ["12.5px", "1.5"],
        body: ["13.5px", "1.55"],
        lead: ["15px", "1.5"],
      },
      borderRadius: { md: "9px", lg: "12px", xl: "16px" },
    },
  },
  plugins: [],
} satisfies Config;
