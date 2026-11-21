/**
 * The console sidebar's headings. Entries carry the heading they sit under
 * (`group`, see NavItem in auth.ts); this cuts the list the person actually
 * gets into runs of one heading each, in order.
 *
 * It only ever splits and labels: every entry that goes in comes out, in the
 * same order, and nothing is folded away. The list it is given is already
 * filtered (an institution without a page, a school without buses, an admin
 * area not held), so a heading whose entries are all gone has no run and shows
 * nothing, and two runs of the same heading that a removed entry used to
 * separate become one.
 */

export interface NavSection<T> {
  /** The heading, or null for the entries above the first one. */
  label: string | null;
  items: T[];
}

export function groupNav<T extends { group?: string }>(items: readonly T[]): NavSection<T>[] {
  const sections: NavSection<T>[] = [];
  for (const item of items) {
    const label = item.group ?? null;
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.items.push(item);
    else sections.push({ label, items: [item] });
  }
  return sections;
}
