import { describe, it, expect } from "vitest";
import { parseTransaction } from "../src/core/parser";

describe("parseTransaction", () => {
  it("parses a plain spend alert", () => {
    expect(parseTransaction("You spent $42.10 at TESCO on 12 Jul")).toEqual({
      amount: 42.1,
      merchant: "TESCO",
      currency: "USD",
    });
  });

  it("parses 'charged' with card-ending noise", () => {
    const r = parseTransaction("Your card ending 1234 was charged $9.99 at NETFLIX.COM.");
    expect(r?.amount).toBe(9.99);
    expect(r?.merchant).toBe("NETFLIX.COM");
  });

  it("handles thousands separators", () => {
    const r = parseTransaction("A purchase of $1,299.00 at APPLE STORE was made");
    expect(r?.amount).toBe(1299);
    expect(r?.merchant).toBe("APPLE STORE");
  });

  it("handles currency-after-amount and GBP", () => {
    const r = parseTransaction("Payment of 15.50 GBP debited at PRET");
    expect(r?.amount).toBe(15.5);
    expect(r?.currency).toBe("GBP");
    expect(r?.merchant).toBe("PRET");
  });

  it("parses £ symbol", () => {
    const r = parseTransaction("You spent £3.20 at COSTA COFFEE");
    expect(r).toEqual({ amount: 3.2, merchant: "COSTA COFFEE", currency: "GBP" });
  });

  it("ignores refunds and credits", () => {
    expect(parseTransaction("A refund of $42.10 was credited to your account")).toBeNull();
    expect(parseTransaction("You received $500.00 from ACME PAYROLL")).toBeNull();
  });

  it("ignores OTP / verification codes", () => {
    expect(parseTransaction("Your one-time code is 123456")).toBeNull();
    expect(parseTransaction("Verification code: 900100")).toBeNull();
  });

  it("ignores declined transactions", () => {
    expect(parseTransaction("Your transaction of $80.00 at BAR was declined")).toBeNull();
  });

  it("returns null for non-financial email", () => {
    expect(parseTransaction("Your monthly newsletter is here!")).toBeNull();
  });

  it("returns null when amount is present but no spend context", () => {
    expect(parseTransaction("Win $1000 in our giveaway")).toBeNull();
  });

  it("copes with missing merchant", () => {
    const r = parseTransaction("You spent $5.00");
    expect(r?.amount).toBe(5);
    expect(r?.merchant).toBeNull();
  });
});
