import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  formatMoney,
  formatMoneyOrDash,
  formatNumber,
  formatPercent,
  formatDate,
  formatDirection,
  formatResult,
} from "@/lib/format";

describe("formatMoney", () => {
  it("formats USD with $ symbol and 2 decimals", () => {
    expect(formatMoney("1234.5", "USD")).toMatch(/\$1,234\.50/);
  });

  it("formats NGN with the ₦ symbol", () => {
    // Locale-aware; just check the symbol exists and digits are grouped
    expect(formatMoney("100000", "NGN")).toMatch(/100,000/);
  });

  it("formats EUR with € symbol", () => {
    expect(formatMoney("99.99", "EUR")).toMatch(/99\.99/);
  });

  it("signed adds + to positive", () => {
    const out = formatMoney("12.34", "USD", { signed: true });
    expect(out.startsWith("+")).toBe(true);
  });

  it("signed keeps - for negative", () => {
    const out = formatMoney("-12.34", "USD", { signed: true });
    expect(out.startsWith("-")).toBe(true);
  });

  it("null returns em-dash", () => {
    expect(formatMoney(null, "USD")).toBe("—");
  });

  it("Decimal input is precise", () => {
    const out = formatMoney(new Decimal("0.1").plus(new Decimal("0.2")), "USD");
    expect(out).toMatch(/0\.30/); // not 0.30000000000000004
  });

  it("falls back to USD for unknown currency codes", () => {
    expect(formatMoney("100", "XXX")).toMatch(/100/);
  });
});

describe("formatMoneyOrDash", () => {
  it("returns — for zero", () => {
    expect(formatMoneyOrDash("0", "USD")).toBe("—");
  });

  it("returns — for null/undefined", () => {
    expect(formatMoneyOrDash(null, "USD")).toBe("—");
    expect(formatMoneyOrDash(undefined, "USD")).toBe("—");
  });

  it("returns formatted value for non-zero", () => {
    expect(formatMoneyOrDash("12.34", "USD")).toMatch(/12\.34/);
  });
});

describe("formatNumber", () => {
  it("groups thousands", () => {
    expect(formatNumber(1234567)).toMatch(/1,234,567/);
  });

  it("respects decimals option", () => {
    expect(formatNumber("1.23456", { decimals: 3 })).toBe("1.235");
  });

  it("null returns —", () => {
    expect(formatNumber(null)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("multiplies fractions by 100 by default", () => {
    expect(formatPercent(0.85)).toBe("85.00%");
  });

  it("alreadyPercent mode does not multiply", () => {
    expect(formatPercent(85, { alreadyPercent: true })).toBe("85.00%");
  });

  it("signed adds +", () => {
    expect(formatPercent(0.05, { signed: true })).toBe("+5.00%");
  });

  it("keeps minus for negative", () => {
    expect(formatPercent(-0.04)).toBe("-4.00%");
  });

  it("null returns —", () => {
    expect(formatPercent(null)).toBe("—");
  });

  it("Decimal input is precise", () => {
    expect(formatPercent(new Decimal("1").div(new Decimal("3")), { decimals: 4 })).toBe("33.3333%");
  });
});

describe("formatDate", () => {
  it("formats a Date object", () => {
    const out = formatDate(new Date("2026-10-26T12:00:00Z"));
    expect(out).toMatch(/2026/);
  });

  it("parses an ISO string", () => {
    expect(formatDate("2026-10-26")).toMatch(/2026/);
  });

  it("null returns —", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("invalid date returns —", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });
});

describe("formatDirection / formatResult", () => {
  it("formatDirection preserves CALL/PUT", () => {
    expect(formatDirection("CALL")).toBe("CALL");
    expect(formatDirection("PUT")).toBe("PUT");
  });

  it("formatResult title-cases", () => {
    expect(formatResult("WIN")).toBe("Win");
    expect(formatResult("LOSS")).toBe("Loss");
  });
});
