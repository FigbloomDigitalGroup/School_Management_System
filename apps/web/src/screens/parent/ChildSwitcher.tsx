import { useParentData } from "../../lib/parentContext";

/**
 * Compact pill switcher for the desktop parent console. Renders nothing for a
 * single-child family — that is the common case, and it would be a pill for
 * a decision that does not exist.
 */
export function ChildSwitcher() {
  const { children, childId, setChildId } = useParentData();
  if (children.length <= 1) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Choose a child">
      {children.map((c) => {
        const active = c.id === childId;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => setChildId(c.id)}
            aria-pressed={active}
            className="hit rounded-full px-3 py-1.5 text-[12.5px] font-medium transition"
            style={active ? { background: "var(--accent)", color: "#fff" } : { background: "#EEF1EE", color: "#5F6B62" }}
          >
            {c.first}
          </button>
        );
      })}
    </div>
  );
}
