import { formatCostWithCoverage } from "@uiu/shared";

/**
 * One recipe price, coverage-aware (cc_prompt_recipe_data_cleanup.md Part 1): "£X.XX" when
 * >= 80% of ingredient lines are priced, "£X.XX+" (with a tooltip) at 50–80%, and muted
 * "Price unavailable" below 50%. All recipe-price surfaces go through this so the thresholds
 * live in one place (@uiu/shared costDisplayTier).
 */
export function CoveragePrice({
  value,
  coveragePct,
  className,
  pendingClassName,
  suffix,
}: {
  value: number;
  coveragePct: number | null | undefined;
  className: string;
  /** Extra class for the muted "Price unavailable" state, e.g. "recipe-card__price--pending". */
  pendingClassName: string;
  /** Small muted unit after the number, e.g. "/ serving". Not shown for "Price unavailable". */
  suffix?: string;
}) {
  const display = formatCostWithCoverage(value, coveragePct);
  const cls = display.tier === "unavailable" ? `${className} ${pendingClassName}` : className;
  return (
    <span className={cls} title={display.note}>
      {display.text}
      {suffix && display.tier !== "unavailable" ? <span className="price-suffix"> {suffix}</span> : null}
    </span>
  );
}
