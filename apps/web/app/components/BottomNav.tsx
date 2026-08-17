"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function HomeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 9.5V21a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}

function MealPlannerIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="4" y="4" width="16" height="17" rx="2" />
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="13" x2="8" y2="13" />
      <line x1="12" y1="13" x2="12" y2="13" />
      <line x1="16" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="8" y2="17" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </svg>
  );
}

function RecipesIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H12v18H5.5A1.5 1.5 0 0 1 4 19.5z" />
      <path d="M20 4.5A1.5 1.5 0 0 0 18.5 3H12v18h6.5a1.5 1.5 0 0 0 1.5-1.5z" />
    </svg>
  );
}

function FridgeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <line x1="5" y1="9" x2="19" y2="9" />
      <line x1="8" y1="5" x2="8" y2="7" />
      <line x1="8" y1="12" x2="8" y2="14" />
    </svg>
  );
}

function ShopIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M6 8h12l-1.5 11a1 1 0 0 1-1 1H8.5a1 1 0 0 1-1-1z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function HealthIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M12 20.5s-7.5-4.6-10-9.3C0.3 8 1.7 4.5 5 3.6c2-.5 3.9.3 5 2 1.1-1.7 3-2.5 5-2 3.3.9 4.7 4.4 3 7.6-2.5 4.7-10 9.3-10 9.3z" />
    </svg>
  );
}

const TABS = [
  { label: "Home", href: "/", Icon: HomeIcon },
  { label: "Meal Planner", href: "/meal-planner", Icon: MealPlannerIcon },
  { label: "Recipes", href: "/recipes", Icon: RecipesIcon },
  { label: "Fridge", href: "/fridge", Icon: FridgeIcon },
  { label: "Shop", href: "/shop", Icon: ShopIcon },
  { label: "Health", href: "/health", Icon: HealthIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav">
      {TABS.map(({ label, href, Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={active ? "bottom-nav__tab bottom-nav__tab--active" : "bottom-nav__tab"}
            aria-label={label}
          >
            <Icon />
          </Link>
        );
      })}
    </nav>
  );
}
