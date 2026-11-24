import { Fragment, type ReactNode } from "react";
import { Pagination } from "./Pagination";
import { usePaging } from "./usePaging";
import { DEFAULT_PAGE_SIZE } from "./DataTable";

/**
 * DataTable's paging for lists that aren't tables (a chat list, "recently
 * sent", a report panel): the first `pageSize` items, and a pager under them
 * once there are more. Back to page 1 when the list changes length.
 */
export function PagedList<T>({ items, render, keyOf, pageSize = DEFAULT_PAGE_SIZE, label = "items", className }: {
  items: T[];
  render: (item: T) => ReactNode;
  keyOf: (item: T) => string;
  pageSize?: number;
  label?: string;
  className?: string;
}) {
  const paging = usePaging(items.length, items.length, pageSize);
  if (items.length <= pageSize) return <>{items.map((i) => <Fragment key={keyOf(i)}>{render(i)}</Fragment>)}</>;
  return (
    <>
      {paging.slice(items).map((i) => <Fragment key={keyOf(i)}>{render(i)}</Fragment>)}
      <div className={className ?? "px-1 pt-1"}>
        <Pagination {...paging.props} pageSizeOptions={[pageSize, 50, 100]} label={label} />
      </div>
    </>
  );
}
