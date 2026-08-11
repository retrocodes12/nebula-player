import type { Metadata } from "next";
// import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppRouterCacheProvider } from '@mui/material-nextjs/v14-appRouter';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import theme from './theme'; // Assuming a theme file exists or will be created
import Header from '../components/Header'; // Import the Header component
import { AddonProvider } from '@/context/AddonContext'; // Import the AddonProvider
import { TmdbProvider } from '@/context/TmdbContext'; // Import the TmdbProvider

// Removed Geist font definitions
// const geistSans = Geist({
//   variable: "--font-geist-sans",
//   subsets: ["latin"],
// });
//
// const geistMono = Geist_Mono({
//   variable: "--font-geist-mono",
//   subsets: ["latin"],
// });

export const metadata: Metadata = {
  title: "Netflix Clone",
  description: "A Next.js Netflix clone with Stremio addon integration",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* Removed font classNames */}
      {/* <body className={`${geistSans.variable} ${geistMono.variable}`}> */}
      <body>
        <AppRouterCacheProvider>
          <ThemeProvider theme={theme}>
            {/* CssBaseline kickstarts an elegant, consistent, and simple baseline to build upon. */}
            <CssBaseline />
            <TmdbProvider>
              <AddonProvider>
                <Header />
                <main>{children}</main>
              </AddonProvider>
            </TmdbProvider>
          </ThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
