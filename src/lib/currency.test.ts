import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  formatCurrency,
  formatCurrencyShort,
} from "./currency";

describe("formatCurrency", () => {
  it("formats whole amounts with no minor units", () => {
    // Use a non-breaking-space-tolerant check: Intl may insert NBSP.
    const out = formatCurrency(1234567, "IDR");
    // Indonesian grouping: dot as thousands separator, no minor units.
    expect(out).toContain("1.234.567");
    expect(out).toContain("Rp");
    expect(out).not.toContain(",00");
  });

  it("defaults to IDR when no currency is given", () => {
    expect(formatCurrency(10)).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("treats an empty-string currency as the default", () => {
    expect(formatCurrency(10, "")).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("coerces non-finite values to 0", () => {
    expect(formatCurrency(Number.NaN, "IDR")).toContain("0");
  });

  it("renders a well-formed but unknown ISO code without throwing", () => {
    // Intl is lenient here — it uses the code as the symbol.
    const out = formatCurrency(1234, "ZZZ");
    expect(out).toContain("ZZZ");
    expect(out).toContain("1.234");
  });

  it("never throws on a structurally invalid code (no DB CHECK on deals.currency)", () => {
    for (const bad of ["United States", "US", "USDD", "12", "u$d"]) {
      expect(() => formatCurrency(1234, bad)).not.toThrow();
      expect(formatCurrency(1234, bad)).toContain("1.234");
    }
  });

  it("formats every offered currency without throwing", () => {
    for (const c of CURRENCIES) {
      expect(() => formatCurrency(1000, c.code)).not.toThrow();
    }
  });
});

describe("Rupiah-only", () => {
  it("offers IDR as the only currency and uses it as the default", () => {
    expect(DEFAULT_CURRENCY).toBe("IDR");
    expect(CURRENCIES.map((c) => c.code)).toEqual(["IDR"]);
  });
});

describe("formatCurrencyShort", () => {
  it("abbreviates rupiah the Indonesian way", () => {
    expect(formatCurrencyShort(2_500_000_000)).toBe("Rp2,5M");
    expect(formatCurrencyShort(1_200_000, "IDR")).toBe("Rp1,2jt");
    expect(formatCurrencyShort(3_400, "IDR")).toBe("Rp3,4rb");
    expect(formatCurrencyShort(900, "IDR")).toBe("Rp900");
  });

  it("falls back to the code for a legacy deal in another currency", () => {
    expect(formatCurrencyShort(1_000, "EUR")).toBe("EUR 1.0k");
  });
});
