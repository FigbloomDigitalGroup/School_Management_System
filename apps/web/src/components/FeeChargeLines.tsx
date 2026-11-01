import { formatMoney, formatShortDate, type FeeCharge } from "@figbloom/shared";
import { Mono } from "./ui/DataTable";

/**
 * Charges the office added to this term's invoice (a lost textbook), under
 * the fee structure on a family's Fees screen. They're already in the
 * billed total and the balance; this says why the total is higher than the
 * fee items add up to. Nothing at all when there are none.
 */
export function FeeChargeLines({ charges, country }: { charges: FeeCharge[]; country: string }) {
  if (!charges.length) return null;
  return (
    <div className="border-t border-line">
      <div className="px-4 pb-1 pt-3 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Charges added this term</div>
      {charges.map((c) => (
        <div key={c.id} className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
          <span className="text-[13px]">
            {c.reason}
            <span className="ml-1.5 text-[12px] text-ink-faint">{formatShortDate(c.createdAt.slice(0, 10))}</span>
          </span>
          <Mono>{formatMoney(c.amountCents, country)}</Mono>
        </div>
      ))}
    </div>
  );
}
