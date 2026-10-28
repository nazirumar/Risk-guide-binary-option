import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  BookOpen,
  Wallet,
  ShieldCheck,
  Calculator,
  BarChart3,
  Target,
  FileText,
  Settings,
  RefreshCw,
  PiggyBank,
  PieChart,
  Trophy,
  Clock,
  Newspaper,
  CreditCard,
  Grid3x3,
} from "lucide-react";

/**
 * App navigation items (PROJECT_RULES.md Phase 3 spec):
 *   Dashboard, Trades, Accounts, Risk Rules, Stake Calculator, Analytics,
 *   Goals, Reports, Settings.
 *
 * `mobile` marks which items get the bottom-tab-bar treatment on small screens
 * (limited to 4-5 by the bottom-bar's space).
 */
export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown on the bottom tab bar (mobile) */
  mobile?: boolean;
  /** Shorter label for the bottom tab bar (defaults to label) */
  shortLabel?: string;
};

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    href: "/app/dashboard",
    icon: LayoutDashboard,
    mobile: true,
    shortLabel: "Home",
  },
  { label: "Trades", href: "/app/trades", icon: BookOpen, mobile: true, shortLabel: "Trades" },
  { label: "Accounts", href: "/app/accounts", icon: Wallet, mobile: true, shortLabel: "Accts" },
  {
    label: "Risk Rules",
    href: "/app/risk-rules",
    icon: ShieldCheck,
    mobile: true,
    shortLabel: "Risk",
  },
  { label: "Stake Calculator", href: "/app/stake-calculator", icon: Calculator },
  { label: "Analytics", href: "/app/analytics", icon: BarChart3 },
  { label: "Strategies", href: "/app/strategies", icon: PieChart },
  { label: "Discipline", href: "/app/discipline", icon: Trophy },
  { label: "Sessions", href: "/app/sessions", icon: Clock },
  { label: "Heatmap", href: "/app/market/heatmap", icon: Grid3x3 },
  { label: "News", href: "/app/news", icon: Newspaper },
  { label: "Goals", href: "/app/goals", icon: Target },
  { label: "Reports", href: "/app/reports", icon: FileText },
  { label: "Balance Sync", href: "/app/balance-sync", icon: RefreshCw },
  { label: "Withdrawal", href: "/app/withdrawal", icon: PiggyBank },
  { label: "Billing", href: "/app/billing", icon: CreditCard },
  { label: "Settings", href: "/app/settings", icon: Settings },
];

export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((n) => n.mobile);
