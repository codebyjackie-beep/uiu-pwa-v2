import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { BottomNav } from "./components/BottomNav";
import { ServiceWorkerKillSwitch } from "./components/ServiceWorkerKillSwitch";

export const metadata: Metadata = {
  title: "UseItUp",
  description: "Plan meals, track your fridge, shop smart, stay healthy.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "UseItUp" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  // shop.useitup.uk is a public marketing page, not part of the app shell — no bottom nav / SW.
  const isPublicShop = (hdrs.get("host") ?? "") === "shop.useitup.uk";

  return (
    <html lang="en">
      <body>
        {!isPublicShop && <ServiceWorkerKillSwitch />}
        <div className="app-shell">{children}</div>
        {!isPublicShop && <BottomNav />}
      </body>
    </html>
  );
}
