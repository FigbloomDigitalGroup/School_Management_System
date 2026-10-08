import type { SlugAvailability } from "../lib/slugAvailability";

/**
 * The line under a web-address field: checking / free / taken, and when it's
 * taken, free alternatives to pick with one click instead of guessing.
 */
export function SlugAvailabilityNote({ slug, noun, base = "figbloom.co.ke/s/", availability, onPick }: {
  slug: string;
  /** The URL the address sits under: schools at /s/, organizations at /org/. */
  base?: string;
  /** What else could own the address: "school" or "organization". */
  noun: string;
  availability: SlugAvailability;
  onPick: (slug: string) => void;
}) {
  const { status, alternatives } = availability;
  if (status === "idle" || status === "unknown") return null;
  if (status === "checking") {
    return <p className="mt-1.5 text-[11.5px] text-ink-faint">Checking {base}{slug}…</p>;
  }
  if (status === "free") {
    return <p className="mt-1.5 text-[11.5px] text-ok-ink">✓ {base}{slug} is free. It can't be changed later, so check the spelling.</p>;
  }
  return (
    <div className="mt-1.5 text-[11.5px] text-warn-ink" role="alert">
      <p>✕ {base}{slug} is already taken by another {noun}.</p>
      {alternatives.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-ink-muted">Try:</span>
          {alternatives.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => onPick(a)}
              className="rounded-full border border-[#D3DAD5] bg-white px-2.5 py-1 font-mono text-[11.5px] text-ink hover:bg-page"
            >
              {a}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
