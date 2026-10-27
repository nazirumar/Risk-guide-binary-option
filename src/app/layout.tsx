import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RiskGuard — Money Management for Binary Options Traders",
  description:
    "RiskGuard is a discipline-first money & risk management app for binary options traders. Track trades, enforce daily limits, visualize equity, and stay in control.",
  keywords: [
    "RiskGuard",
    "binary options",
    "money management",
    "risk management",
    "trading journal",
    "trading discipline",
    "drawdown",
  ],
  authors: [{ name: "RiskGuard" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  manifest: "/manifest.json",
  themeColor: "#0f172a",
  openGraph: {
    title: "RiskGuard",
    description: "Money & risk management for binary options traders",
    siteName: "RiskGuard",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "RiskGuard",
    description: "Money & risk management for binary options traders",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <AuthProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </AuthProvider>
        <Toaster />
      </body>
    </html>
  );
}
