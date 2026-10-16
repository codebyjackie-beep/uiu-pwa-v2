import { formatPricesChecked, STOCK_PRICE_NOTE } from "@uiu/shared";

/**
 * "Prices checked Oct 2026" + a small ⓘ that expands the price explanation (touch-friendly: a native
 * <details>, no title-tooltip). Renders nothing when the stamp is 0/missing. Display only.
 */
export function PricesChecked({ stamp }: { stamp: number | null | undefined }) {
  const label = formatPricesChecked(stamp);
  if (!label) return null;
  return (
    <details className="prices-checked">
      <summary>
        <span>{label}</span>
        <span className="prices-checked__info" aria-label="About these prices">
          ⓘ
        </span>
      </summary>
      <p className="prices-checked__note">{STOCK_PRICE_NOTE}</p>
    </details>
  );
}
