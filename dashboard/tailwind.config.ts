import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  // Class-based dark mode: Tailwind's `dark:` variant applies when any
  // ancestor has `class="dark"`. The no-flash script in app/layout.tsx
  // adds it to <html> before paint, and ThemeToggle flips it at runtime.
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Onfon Group corporate palette — picked off the logo's
        // rainbow swirl. `onfon.red` is the primary accent (most
        // prominent in the wordmark); the rest feed the `brand-gradient`
        // utility for subtle accents (top sidebar strip, focus rings).
        onfon: {
          red:    "#E91E63",
          orange: "#F7941D",
          yellow: "#FBC02D",
          green:  "#43A047",
          cyan:   "#00ACC1",
          blue:   "#1E88E5",
          violet: "#8E24AA",
          ink:    "#1F1F1F",
        },
      },
      backgroundImage: {
        // Horizontal rainbow — 3-px brand strip + active-nav glow.
        "brand-gradient":
          "linear-gradient(90deg, #E91E63 0%, #F7941D 18%, #FBC02D 36%, #43A047 54%, #00ACC1 70%, #1E88E5 85%, #8E24AA 100%)",
      },
      boxShadow: {
        "brand-focus": "0 0 0 2px rgba(233, 30, 99, 0.35)",
      },
    },
  },
  plugins: [],
};
export default config;
