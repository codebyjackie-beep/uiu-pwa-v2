/** Shared copy between OnboardingOverlay.tsx and app/how-it-works/page.tsx — same feature
 * list and how-it-works steps, don't fork the wording in two places. Kept in a plain
 * (non "use client") module so a Server Component (how-it-works/page.tsx) can import it
 * without crossing the client/server boundary that OnboardingOverlay.tsx sits on. */

export const FEATURE_CARDS = [
  { icon: "🍳", label: "Browse Recipes", hint: "Real UK prices" },
  { icon: "🧊", label: "Scan Fridge", hint: "Track what you've got" },
  { icon: "🛒", label: "Compare Prices", hint: "Shop smarter" },
  { icon: "❤️", label: "Track Health", hint: "Macros & BMI" },
] as const;

export const HOW_IT_WORKS = [
  "Track what's in your fridge",
  "Get recipes & a shopping list that fits your budget",
  "Cook, log, and cut food waste",
] as const;
