import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import "./globals.css";
import { AccountHeader } from "./components/AccountHeader";
import { BottomNav } from "./components/BottomNav";
import { ServiceWorkerKillSwitch } from "./components/ServiceWorkerKillSwitch";
import { SiteFooter } from "./components/SiteFooter";

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
  const { userId } = isPublicShop ? { userId: null } : await auth();

  return (
    <html lang="en">
      <body>
        <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" afterSignOutUrl="/how-it-works">
          {!isPublicShop && <ServiceWorkerKillSwitch />}
          {!isPublicShop && <AccountHeader isSignedIn={!!userId} />}
          <div className={!isPublicShop && userId ? "app-shell app-shell--with-account-header" : "app-shell"}>
            {children}
          </div>
          {!isPublicShop && <SiteFooter />}
          {!isPublicShop && <BottomNav />}
        </ClerkProvider>
      </body>
    </html>
  );
}
