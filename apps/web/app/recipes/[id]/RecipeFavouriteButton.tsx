"use client";

import { useEffect, useState } from "react";
import type { ApiResponse, FavouriteRecipe } from "@uiu/shared";
import { useGuestGate } from "../../components/GuestGate";

/**
 * cc_prompt_guest_browse.md Part D1 — ❤️ beside the recipe title. Same API
 * (/api/favourite-recipes GET / POST / DELETE) and the same optimistic toggle as the heart on the
 * list cards in RecipesBrowser.tsx, so both read the same server state: the list re-reads it on
 * mount, so what you set here is what the list shows when you go back. Guests never call the API —
 * tapping opens the sign-up sheet.
 */
export function RecipeFavouriteButton({ recipeId }: { recipeId: string }) {
  const { isSignedIn, requireAuth } = useGuestGate();
  const [isFavourite, setIsFavourite] = useState(false);
  const [loaded, setLoaded] = useState(!isSignedIn);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/favourite-recipes");
      const parsed = (await res.json().catch(() => null)) as ApiResponse<FavouriteRecipe[]> | null;
      if (cancelled) return;
      if (parsed?.ok) setIsFavourite(parsed.data.some((f) => f.recipeId === recipeId));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, recipeId]);

  async function toggle() {
    if (!requireAuth()) return;
    const wasFavourite = isFavourite;
    setIsFavourite(!wasFavourite);
    const res = wasFavourite
      ? await fetch(`/api/favourite-recipes/${recipeId}`, { method: "DELETE" })
      : await fetch("/api/favourite-recipes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipeId }),
        });
    const parsed = (await res.json().catch(() => null)) as ApiResponse<unknown> | null;
    if (!parsed?.ok) setIsFavourite(wasFavourite);
  }

  return (
    <button
      type="button"
      className={`recipe-detail__favourite${isFavourite ? " recipe-detail__favourite--active" : ""}`}
      aria-label={isFavourite ? "Remove from favourites" : "Add to favourites"}
      aria-pressed={isFavourite}
      disabled={!loaded}
      onClick={() => void toggle()}
    >
      {isFavourite ? "♥" : "♡"}
    </button>
  );
}
