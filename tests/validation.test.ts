import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  onboardingSchema,
  updateProfileSchema,
  changePasswordSchema,
  deleteAccountSchema,
  passwordSchema,
} from "@/lib/validation";

/**
 * Phase 2 auth validation tests — exercises the Zod schemas that gate every
 * auth server action (PROJECT_RULES.md rule #4: validate on the server even
 * if the client validates too).
 */

describe("passwordSchema", () => {
  it("accepts a strong password", () => {
    expect(passwordSchema.safeParse("GoodPass123!").success).toBe(true);
  });
  it("rejects too short", () => {
    expect(passwordSchema.safeParse("Ab1!").success).toBe(false);
  });
  it("rejects too long", () => {
    expect(passwordSchema.safeParse("A".repeat(101) + "1!b").success).toBe(false);
  });
  it("rejects missing uppercase", () => {
    expect(passwordSchema.safeParse("lowercase123!").success).toBe(false);
  });
  it("rejects missing lowercase", () => {
    expect(passwordSchema.safeParse("UPPERCASE123!").success).toBe(false);
  });
  it("rejects missing digit", () => {
    expect(passwordSchema.safeParse("NoDigitsHere!").success).toBe(false);
  });
  it("rejects missing special char", () => {
    expect(passwordSchema.safeParse("OnlyLetters123").success).toBe(false);
  });
});

describe("registerSchema", () => {
  const validBase = {
    name: "Test",
    email: "test@example.com",
    password: "GoodPass123!",
    confirmPassword: "GoodPass123!",
    acceptTerms: true as const,
  };
  it("accepts valid input", () => {
    expect(registerSchema.safeParse(validBase).success).toBe(true);
  });
  it("rejects mismatched passwords", () => {
    expect(
      registerSchema.safeParse({ ...validBase, confirmPassword: "Different123!" }).success,
    ).toBe(false);
  });
  it("rejects missing acceptTerms", () => {
    expect(registerSchema.safeParse({ ...validBase, acceptTerms: undefined }).success).toBe(false);
  });
  it("rejects invalid email", () => {
    expect(registerSchema.safeParse({ ...validBase, email: "not-an-email" }).success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("accepts valid credentials shape", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "anything" }).success).toBe(true);
  });
  it("rejects empty password", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
  });
  it("rejects malformed email", () => {
    expect(loginSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
  });
});

describe("forgotPasswordSchema", () => {
  it("accepts valid email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "x@y.com" }).success).toBe(true);
  });
  it("rejects non-email string", () => {
    expect(forgotPasswordSchema.safeParse({ email: "x" }).success).toBe(false);
  });
});

describe("resetPasswordSchema", () => {
  const valid = {
    token: "abc-123",
    password: "GoodPass123!",
    confirmPassword: "GoodPass123!",
  };
  it("accepts valid input", () => {
    expect(resetPasswordSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects mismatched passwords", () => {
    expect(
      resetPasswordSchema.safeParse({ ...valid, confirmPassword: "WrongPass123!" }).success,
    ).toBe(false);
  });
  it("rejects empty token", () => {
    expect(resetPasswordSchema.safeParse({ ...valid, token: "" }).success).toBe(false);
  });
});

describe("verifyEmailSchema", () => {
  it("accepts non-empty token", () => {
    expect(verifyEmailSchema.safeParse({ token: "x" }).success).toBe(true);
  });
  it("rejects empty token", () => {
    expect(verifyEmailSchema.safeParse({ token: "" }).success).toBe(false);
  });
});

describe("onboardingSchema", () => {
  const valid = {
    baseCurrency: "USD",
    timezone: "UTC",
    accountName: "My Account",
    broker: "Quotex",
    accountType: "DEMO" as const,
    startingBalance: 1000,
    riskPerTradePercent: 2,
    maxDailyLossPercent: 6,
    maxConsecutiveLosses: 3,
  };
  it("accepts valid input", () => {
    expect(onboardingSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects currency too short", () => {
    expect(onboardingSchema.safeParse({ ...valid, baseCurrency: "US" }).success).toBe(false);
  });
  it("rejects negative starting balance", () => {
    expect(onboardingSchema.safeParse({ ...valid, startingBalance: -1 }).success).toBe(false);
  });
  it("rejects maxConsecutiveLosses < 1", () => {
    expect(onboardingSchema.safeParse({ ...valid, maxConsecutiveLosses: 0 }).success).toBe(false);
  });
  it("accepts REAL account type", () => {
    expect(onboardingSchema.safeParse({ ...valid, accountType: "REAL" as const }).success).toBe(
      true,
    );
  });
});

describe("updateProfileSchema", () => {
  it("accepts valid input", () => {
    expect(
      updateProfileSchema.safeParse({
        name: "Me",
        timezone: "UTC",
        baseCurrency: "USD",
      }).success,
    ).toBe(true);
  });
});

describe("changePasswordSchema", () => {
  it("accepts valid input", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "oldPass123!",
        newPassword: "newPass456!",
        confirmPassword: "newPass456!",
      }).success,
    ).toBe(true);
  });
  it("rejects missing currentPassword", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "",
        newPassword: "newPass456!",
        confirmPassword: "newPass456!",
      }).success,
    ).toBe(false);
  });
  it("rejects mismatched new passwords", () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: "oldPass123!",
        newPassword: "newPass456!",
        confirmPassword: "different456!",
      }).success,
    ).toBe(false);
  });
});

describe("deleteAccountSchema", () => {
  it("accepts exact phrase", () => {
    expect(deleteAccountSchema.safeParse({ confirmPhrase: "DELETE MY ACCOUNT" }).success).toBe(
      true,
    );
  });
  it("rejects wrong phrase", () => {
    expect(deleteAccountSchema.safeParse({ confirmPhrase: "delete my account" }).success).toBe(
      false,
    );
  });
  it("rejects empty", () => {
    expect(deleteAccountSchema.safeParse({ confirmPhrase: "" }).success).toBe(false);
  });
});

// Sanity-check that Decimal is still precise in the test env (Phase 0 sanity
// check carried forward — proves the test runner + decimal.js are wired).
describe("decimal precision smoke", () => {
  it("0.1 + 0.2 === 0.3 in Decimal", () => {
    expect(new Decimal("0.1").plus(new Decimal("0.2")).toString()).toBe("0.3");
  });
});
