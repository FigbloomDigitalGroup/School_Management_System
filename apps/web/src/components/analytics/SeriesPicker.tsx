import { MAX_SERIES, SERIES_COLORS } from "./ChartFrame";

interface Props {
  options: { id: string; name: string }[];
  /** In options order is what the chart draws, so colours follow that order. */
  chosen: string[];
  onChange: (ids: string[]) => void;
  label: string;
}

/** Toggle chips for which series a line chart shows, up to the four colour slots. */
export function SeriesPicker({ options, chosen, onChange, label }: Props) {
  const drawn = options.filter((o) => chosen.includes(o.id));
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {options.map((o) => {
        const on = chosen.includes(o.id);
        const full = !on && chosen.length >= MAX_SERIES;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            disabled={full}
            title={full ? `Up to ${MAX_SERIES} at a time` : undefined}
            onClick={() => onChange(on ? chosen.filter((c) => c !== o.id) : [...chosen, o.id])}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-50 ${on ? "border-ink/30 bg-sunken font-medium text-ink" : "border-line bg-white text-ink-muted hover:bg-page"}`}
          >
            {on && <span className="viz-swatch viz-swatch-line" style={{ background: SERIES_COLORS[drawn.findIndex((d) => d.id === o.id)] }} aria-hidden />}
            {o.name}
          </button>
        );
      })}
    </div>
  );
}
