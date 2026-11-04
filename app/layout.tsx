import type { Metadata } from "next";
import { JetBrains_Mono, Playfair_Display, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", weight: ["400", "500", "600", "700", "800"], display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-playfair", weight: ["500", "600"], style: ["italic"], display: "swap" });
const jbmono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono", weight: ["400", "500", "600"], display: "swap" });

export const metadata: Metadata = {
  title: "Freshroots: rules-first demand planning",
  description: "Deterministic rules decide every reorder. Gemini forecasts and explains. Raghav approves every recommendation before anything becomes a purchase order.",
};

// Light is the default theme; applied before paint so there is no flash.
const themeScript = `try{if(localStorage.getItem("theme")!=="dark")document.documentElement.classList.add("light")}catch(e){document.documentElement.classList.add("light")}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${jakarta.variable} ${playfair.variable} ${jbmono.variable}`}>
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@500,700,800,900&display=swap" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
