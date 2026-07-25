"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Home", href: "/" },
  { label: "Meal Planner", href: "/meal-planner" },
  { label: "Recipes", href: "/recipes" },
  { label: "Shop", href: "/shop" },
  { label: "Fridge", href: "/fridge" },
  { label: "Health", href: "/health" },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav">
      {TABS.map((tab) => {
        const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link key={tab.href} href={tab.href} className={active ? "bottom-nav__tab bottom-nav__tab--active" : "bottom-nav__tab"}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
