import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./globals.css";
import { AppHeader } from "./components/AppHeader";
import { BottomNav } from "./components/BottomNav";
import { AppShell, GuestBanner, GuestGateProvider } from "./components/GuestGate";
import { ServiceWorkerKillSwitch } from "./components/ServiceWorkerKillSwitch";
import { SiteFooter } from "./components/SiteFooter";

export const metadata: Metadata = {
  title: "UseItUp",
  description: "Plan meals, track your fridge, shop smart, stay healthy.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "UseItUp" },
};

export const viewport: Viewport = {
  themeColor: "#f3ede2",
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
          <GuestGateProvider serverSignedIn={!!userId}>
            {!isPublicShop && <ServiceWorkerKillSwitch />}
            {!isPublicShop && <AppHeader />}
            <AppShell publicShop={isPublicShop}>
              {!isPublicShop && <GuestBanner />}
              {children}
            </AppShell>
            {!isPublicShop && <SiteFooter />}
            {!isPublicShop && <BottomNav />}
          </GuestGateProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
