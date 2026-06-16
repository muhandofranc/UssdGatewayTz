import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UssdGatewayTz — Dashboard",
  description: "USSD reseller gateway — reports & operations",
};

/**
 * No-flash theme initialiser. Runs BEFORE React hydrates: reads the
 * user's saved preference (localStorage.theme = 'dark' | 'light') or
 * falls back to the system preference, and stamps `.dark` on <html>
 * synchronously so the first paint already has the right palette.
 *
 * Inlining via dangerouslySetInnerHTML is the standard pattern for
 * this in React — there's no other way to run code before hydration.
 * The `try/catch` covers privacy-mode localStorage throwing.
 */
const NO_FLASH_THEME_JS = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = stored ? stored === 'dark' : sysDark;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning on <html> — the no-flash script may add
    // the `dark` class server-side mismatch; this is the React-blessed
    // way to silence the warning for this exact use case.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_JS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
