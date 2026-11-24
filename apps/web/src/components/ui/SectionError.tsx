import { Button } from "./Button";

/**
 * A section that failed to load: what went wrong and a way to try again, so
 * one slow or failed read never leaves the rest of the page broken.
 */
export function SectionError({ what, error, onRetry, boxed }: { what: string; error: Error; onRetry: () => void; boxed?: boolean }) {
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-warn-ink ${boxed ? "rounded-lg border border-line bg-white px-4 py-3" : "py-2"}`}>
      <span className="min-w-0">Could not {what}: {error.message.replace(/\.?$/, ".")}</span>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}
