import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "@fontsource/bricolage-grotesque/800.css";
import "./globals.css";
import { AppHeader } from "./components/AppHeader";
import { BottomNav } from "./components/BottomNav";
import { AppShell, GuestBanner, GuestGateProvider } from "./components/GuestGate";
import { ServiceWorkerKillSwitch } from "./components/ServiceWorkerKillSwitch";
import { SiteFooter } from "./components/SiteFooter";

export const metadata: Metadata = {
  metadataBase: new URL("https://useitup.uk"),
  title: "UseItUp",
  description: "Plan meals, track your fridge, shop smart, stay healthy.",
  // Link previews (IG bio, WhatsApp, iMessage, X) — 1200×630 share card.
  openGraph: {
    type: "website",
    url: "https://useitup.uk",
    siteName: "UseItUp",
    title: "UseItUp — cook what's about to go off",
    description: "See what to use first, what to cook, and what it costs at UK supermarkets. Free, no sign-up to try.",
    images: [{ url: "/og-image.png?v=1", width: 1200, height: 630, alt: "UseItUp app: use it up soon, recipes priced at UK supermarkets" }],
    locale: "en_GB",
  },
  twitter: {
    card: "summary_large_image",
    title: "UseItUp — cook what's about to go off",
    description: "See what to use first, what to cook, and what it costs at UK supermarkets. Free, no sign-up to try.",
    images: ["/og-image.png?v=1"],
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
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
