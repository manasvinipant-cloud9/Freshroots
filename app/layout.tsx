import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Freshroots demand planning", description: "Rules-first demand planning with AI at the edges. Raghav approves every recommendation." };

// Applies the saved theme before paint so there is no flash.
const themeScript = `try{if(localStorage.getItem("theme")==="light")document.documentElement.classList.add("light")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
