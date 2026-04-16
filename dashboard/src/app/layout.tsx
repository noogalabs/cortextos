import type { Metadata } from "next";
import { Sora, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getDefaultBrand } from "@/lib/data/organization";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

// Resolved at request time so metadata reflects the currently active brand
// without needing a dashboard rebuild when org context.json changes.
export async function generateMetadata(): Promise<Metadata> {
  const brand = getDefaultBrand();
  const descriptionSuffix = brand.isOrgBrand
    ? `${brand.name} agent orchestration dashboard`
    : "cortextOS agent orchestration dashboard";
  return {
    title: `${brand.name} Dashboard`,
    description: descriptionSuffix,
    viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: brand.shortName,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <SessionProvider>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
            <TooltipProvider>
              {children}
            </TooltipProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
