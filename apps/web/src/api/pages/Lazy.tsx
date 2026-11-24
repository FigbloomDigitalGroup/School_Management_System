import { Suspense, type ReactNode } from "react";
import { Skeleton } from "../../components/ui/Skeleton";

/** Wraps a `lazy()` page: shows a skeleton while its code loads. */
export function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="space-y-3 p-8">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
