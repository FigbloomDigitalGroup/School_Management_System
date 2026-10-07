import type { CSSProperties, ReactNode } from "react";

/** What a signed-out page shows for one portal. Art lives in public/portals/. */
export interface Scene {
  art: string;
  /** Soft background behind the art, sampled from the illustration. */
  tint: string;
  /** Buttons, links and focus highlights — a deeper shade of the tint, AA on white. */
  accent: string;
  accentDeep: string;
  headline: string;
  tagline: string;
}

/**
 * The signed-out pages (sign-in, new-organization signup): an illustrated
 * panel on the left in the scene's tint, the form on the right on a lighter
 * wash of the same tint, split by a soft divider. Buttons, links and input
 * focus take the scene's accent via the `.auth-theme` rules in index.css.
 * Below `lg` the panel collapses to a tinted banner above the form.
 */
export function AuthLayout({ scene, subtitle, width = 420, children }: {
  scene: Scene;
  /** Mono caption under the wordmark, e.g. "TEACHER PORTAL". */
  subtitle: string;
  /** Max width of the form column, in px. */
  width?: number;
  children: ReactNode;
}) {
  const vars = {
    "--portal": scene.accent,
    "--portal-deep": scene.accentDeep,
    "--portal-tint": scene.tint,
    "--portal-wash": `color-mix(in srgb, ${scene.tint} 40%, #FCFCFA)`,
  } as CSSProperties;

  return (
    <div
      style={vars}
      className="auth-theme grid min-h-screen bg-[var(--portal-wash)] transition-colors duration-500 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
    >
      <aside className="sticky top-0 hidden h-screen flex-col justify-between overflow-hidden bg-[var(--portal-tint)] p-10 transition-colors duration-500 lg:flex">
        <Brand subtitle={subtitle} />
        <img key={scene.art} src={scene.art} alt="" className="animate-rise mx-auto my-8 min-h-0 w-full max-w-[600px] object-contain" />
        <div key={scene.headline} className="animate-rise max-w-[460px]">
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{scene.headline}</h1>
          <p className="mt-2 text-lead text-ink-muted">{scene.tagline}</p>
        </div>
      </aside>

      <main className="flex items-center justify-center px-4 py-8 sm:p-8 lg:border-l lg:border-black/[0.06] lg:shadow-[-12px_0_32px_-24px_rgba(0,0,0,0.18)]">
        <div className="w-full" style={{ maxWidth: width }}>
          <div className="mb-5 lg:hidden">
            <Brand subtitle={subtitle} />
            <div className="mt-4 rounded-xl bg-[var(--portal-tint)] px-4 py-3 transition-colors duration-500">
              <img key={scene.art} src={scene.art} alt="" className="animate-rise mx-auto h-36 w-full object-contain" />
            </div>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

/** The bare green mark, no tile — the brand stays green whatever the portal colour. */
function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/figbloom-mark.png" alt="Figbloom" className="h-11 w-11 object-contain" />
      <div>
        <div className="text-[17px] font-semibold tracking-tight">Figbloom School Systems</div>
        <div className="font-mono text-[9.5px] tracking-[0.12em] text-ink-faint">{subtitle}</div>
      </div>
    </div>
  );
}
