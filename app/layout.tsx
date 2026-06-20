import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { SwRegister } from "@/components/sw-register";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Sarathi — Asisten Event Organizer di WhatsApp",
  description: "Dari chat WhatsApp, jadi acara ter-booking. Asisten AI untuk Event Organizer.",
  applicationName: "Sarathi",
  // Installable PWA niceties for iOS "Add to Home Screen".
  appleWebApp: {
    capable: true,
    title: "Sarathi",
    statusBarStyle: "default",
  },
};

// viewport-fit=cover so env(safe-area-inset-*) resolves to real values on
// notched phones — the shell pads the bottom of the nav and main with it.
// theme-color follows the OS light/dark scheme so the browser/OS chrome matches.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          <SwRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
