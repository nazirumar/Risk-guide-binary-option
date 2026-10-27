"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

/**
 * ThemeProvider wrapper — defaults to dark mode (PROJECT_RULES.md: dark mode
 * default for traders who work long hours). Persisted in a cookie so the
 * toggle survives hard refreshes. `attribute="class"` toggles a `.dark` class
 * on <html> that our globals.css overrides target.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
