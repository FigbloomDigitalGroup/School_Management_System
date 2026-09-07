/**
 * Loading states. Deliberately shaped like the content that is coming so the
 * page does not jump — parents on 3G see this for real seconds, not a flash.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-line-soft ${className}`} />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-white">
      <div className="border-b border-line bg-sunken px-4 py-2.5"><Skeleton className="h-2.5 w-40" /></div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3.5 border-b border-line-soft px-4 py-3.5">
          <Skeleton className="h-7 w-7 shrink-0 rounded-lg" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function OfflineBanner({ pending }: { pending: number }) {
  return (
    <div className="flex items-center gap-3 border-b border-orange-line bg-orange-soft px-4 py-2.5 text-small text-orange-ink">
      <span className="h-2 w-2 shrink-0 rounded-full bg-orange" aria-hidden />
      {pending > 0
        ? `No network. ${pending} ${pending === 1 ? "register is" : "registers are"} saved on this device and will send when you are back online.`
        : "No network. You can still take attendance — it will send when you are back online."}
    </div>
  );
}
