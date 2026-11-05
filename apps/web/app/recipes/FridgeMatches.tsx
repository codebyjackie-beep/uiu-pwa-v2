"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ApiResponse, MealSuggestion, MealSuggestionsResponse } from "@uiu/shared";
import { CoveragePrice } from "../components/CoveragePrice";

/**
 * /recipes?cook=soon — opened from Home "Use it up soon" → "Cook with these" (Jackie 2026-11-05).
 * Lists existing recipes that use fridge items expiring within 3 days (no AI, no quota). Living in the URL means
 * going back from a recipe shows the same list again.
 */
export function FridgeMatches() {
  const params = useSearchParams();
  const active = params.get("cook") === "soon";
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "done"; items: MealSuggestion[] }>({
    status: "loading",
  });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/meal-suggestions?matchOnly=1&days=3");
        const parsed = (await res.json()) as ApiResponse<MealSuggestionsResponse>;
        if (cancelled) return;
        setState(parsed.ok ? { status: "done", items: parsed.data.suggestions } : { status: "error" });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  if (!active) return null;

  return (
    <section className="tonight-suggestion" aria-label="Uses what's in your fridge">
      <div className="tonight-suggestion__header-row">
        <h2 className="tonight-suggestion__heading">Uses what&apos;s in your fridge</h2>
      </div>

      {state.status === "loading" ? <p className="tonight-suggestion__status">Finding recipes…</p> : null}
      {state.status === "error" ? (
        <p className="tonight-suggestion__status">Couldn&apos;t load matching recipes — please try again.</p>
      ) : null}
      {state.status === "done" && state.items.length === 0 ? (
        <>
          <p className="tonight-suggestion__status">No recipes use these yet.</p>
          <Link href="/fridge" className="wizard-secondary-button">
            Cook with what I have
          </Link>
        </>
      ) : null}

      {state.status === "done" && state.items.length > 0 ? (
        <div className="tonight-suggestion__grid">
          {state.items.map((s) => (
            <div key={s.recipeId} className="recipe-card tonight-suggestion__card">
              <Link href={`/recipes/${s.recipeId}`} className="tonight-suggestion__card-link">
                {s.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="recipe-card__image" src={s.imageUrl} alt="" />
                ) : (
                  <div className="recipe-card__image" />
                )}
                <div className="recipe-card__body">
                  <p className="recipe-card__title">{s.title}</p>
                  <div className="recipe-card__macros">
                    {s.cost ? (
                      <CoveragePrice
                        value={s.cost.perServing}
                        coveragePct={s.cost.adjustedCoveragePct}
                        className="recipe-card__price"
                        pendingClassName="recipe-card__price--pending"
                      />
                    ) : (
                      <span className="recipe-card__price">—</span>
                    )}
                  </div>
                  <p className="tonight-suggestion__match">Uses {s.matchedFridgeItems.join(", ")}</p>
                </div>
              </Link>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
