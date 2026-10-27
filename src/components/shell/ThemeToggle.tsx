"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Theme toggle — renders a placeholder until next-themes hydrates, then
 * shows the current theme's icon. Default is dark mode (PROJECT_RULES.md);
 * clicking flips the .dark class on <html> via the ThemeProvider.
 *
 * We avoid the `useEffect(() => setMounted(true))` pattern (lint error) by
 * resolving the icon during render based on `theme` — next-themes returns
 * undefined on the very first render and the actual value thereafter, so
 * we just check for that.
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  // resolvedTheme is undefined during SSR + initial hydration; resolves to
  // 'light' or 'dark' on the client. Using it avoids the layout shift of
  // a separate "mounted" state.
  const current = resolvedTheme ?? theme ?? "dark";
  const isDark = current === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
    >
      {/* Render both icons; CSS keeps the matching one visible. */}
      <Sun
        className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
        aria-hidden="true"
      />
      <Moon
        className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
        aria-hidden="true"
      />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
