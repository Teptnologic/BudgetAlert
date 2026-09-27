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

  it("parses a Chase alert without a merchant clause", () => {
    const r = parseTransaction("You made a $10.46 transaction");
    expect(r?.amount).toBe(10.46);
    expect(r?.currency).toBe("USD");
  });

  it("reads the merchant from the Chase subject, not the body", () => {
    // Real Chase shape: merchant is at the end of the subject; the body is
    // boilerplate that must NOT leak into the merchant.
    const subject = "You made a $84.00 transaction with TOP GOLF BAY RESERVA";
    const body =
      "Account ending in (...1234). Don't recognize it? Call us. Reply STOP to unsubscribe. Manage alerts at chase.com.";
    const r = parseTransaction(subject, body);
    expect(r?.amount).toBe(84);
    expect(r?.merchant).toBe("TOP GOLF BAY RESERVA");
  });

  it("parses a Chase alert with a merchant", () => {
    const r = parseTransaction("You made a $10.46 transaction with STARBUCKS on July 21, 2026");
    expect(r?.amount).toBe(10.46);
    expect(r?.merchant).toBe("STARBUCKS");
  });

  it("does not treat 'with your ... card' as a merchant", () => {
    const r = parseTransaction("You made a $10.46 transaction with your Freedom card");
    expect(r?.amount).toBe(10.46);
    expect(r?.merchant).toBeNull();
  });

  it("parses a Wells Fargo alert with labelled merchant and date", () => {
    // Real Wells Fargo shape: amount in a sentence, merchant on its own line,
    // followed by a Date line and unsubscribe boilerplate.
    const subject = "Wells Fargo Purchase Alert";
    const body = [
      "You made a purchase of $24.31",
      "Merchant: TRADER JOES #123",
      "Date: 08/14/2026 09:14 AM PT",
      "You received this message because you set up alerts. Manage them in Wells Fargo Online.",
    ].join("\n");
    const r = parseTransaction(subject, body);
    expect(r?.amount).toBe(24.31);
    expect(r?.merchant).toBe("TRADER JOES #123");
    expect(r?.currency).toBe("USD");
  });

  it("keeps dots in a Wells Fargo merchant name", () => {
    const r = parseTransaction(
      "Wells Fargo Purchase Alert",
      "You made a purchase of $1,299.00\nMerchant: AMAZON.COM\nDate: Aug 14, 2026",
    );
    expect(r?.amount).toBe(1299);
    expect(r?.merchant).toBe("AMAZON.COM");
  });

  it("parses a Wells Fargo alert with no merchant line", () => {
    const r = parseTransaction("Wells Fargo Purchase Alert", "You made a purchase of $8.00.");
    expect(r?.amount).toBe(8);
    expect(r?.merchant).toBeNull();
  });

  it("ignores a Wells Fargo reversal alert", () => {
    const r = parseTransaction(
      "Wells Fargo purchase reversed",
      "You made a purchase of $24.31\nMerchant: TRADER JOES #123",
    );
    expect(r).toBeNull();
  });

  it("copes with missing merchant", () => {
    const r = parseTransaction("You spent $5.00");
    expect(r?.amount).toBe(5);
    expect(r?.merchant).toBeNull();
  });

  it("parses an AMEX Large Purchase Approved alert", () => {
    const subject = "Large Purchase Approved";
    const body = [
      "As you requested, we're letting you know that this purchase was more than $1.00.",
      "You can change the dollar amount of these large purchase notifications online.",
      "ISLAND PACKERS",
      "$144.00*",
      "Sun, Sep 27, 2026",
      "*The amount above may not reflect the final amount as some merchants issue a pre-authorization charge",
    ].join("\n");
    const r = parseTransaction(subject, body);
    expect(r?.amount).toBe(144);
    expect(r?.merchant).toBe("ISLAND PACKERS");
    expect(r?.currency).toBe("USD");
  });

  it("parses an AMEX Large Purchase with a high threshold", () => {
    const subject = "Large Purchase Approved";
    const body = [
      "As you requested, we're letting you know that this purchase was more than $500.00.",
      "You can change the dollar amount of these large purchase notifications online.",
      "WHOLE FOODS MKT #10234",
      "$1,250.99*",
      "Mon, Sep 28, 2026",
      "*The amount above may not reflect the final amount",
    ].join("\n");
    const r = parseTransaction(subject, body);
    expect(r?.amount).toBe(1250.99);
    expect(r?.merchant).toBe("WHOLE FOODS MKT #10234");
    expect(r?.currency).toBe("USD");
  });

  it("parses a forwarded AMEX Large Purchase email (real text/plain)", () => {
    const subject = "Fwd: Large Purchase Approved";
    const body = [
      "---------- Forwarded message ---------",
      "From: American Express <AmericanExpress@welcome.americanexpress.com>",
      "Date: Sun, Sep 27, 2026 at 12:58 AM",
      "Subject: Large Purchase Approved",
      "To: <yyy@gmail.com>",
      "",
      "",
      "See the details about this purchase",
      "",
      "*XIAOYAN XIE*",
      "",
      "Account Ending: 51006",
      "",
      "*There was a large purchase on your Card*",
      "",
      "Dear XIAOYAN XIE,",
      "",
      "As you requested, we're letting you know that this purchase was more than",
      "$1.00.",
      "",
      "You can* change the dollar amount",
      "*of these large purchase notifications online.",
      "",
      "ISLAND PACKERS",
      "",
      "$144.00*",
      "",
      "Sun, Sep 27, 2026",
      "",
      "*The amount above may not reflect the final amount as some merchants issue",
      "a pre-authorization charge",
      "",
      "You can track this spending charge online",
      "and be notified when the final amount is posted to your account.",
      "",
      "If you still have questions about this transaction, we suggest contacting",
      "the merchant directly.",
      "Contact us",
      "Update your email address",
      "Privacy statement",
      "",
      "To stop alerts click here",
      "",
      "Your account information is included above to help you recognize this as a",
      "customer care email from American Express.",
      "",
      "© 2026 American Express. All rights reserved.",
      "",
      "SAM0FYI568",
    ].join("\n");
    const r = parseTransaction(subject, body);
    expect(r?.amount).toBe(144);
    expect(r?.merchant).toBe("ISLAND PACKERS");
    expect(r?.currency).toBe("USD");
  });

  it("parses an AMEX Large Purchase with a dotted merchant name", () => {
    const subject = "Large Purchase Approved";
    const body = [
      "As you requested, we're letting you know that this purchase was more than $1.00.",
      "You can change the dollar amount of these large purchase notifications online.",
      "AMAZON.COM",
      "$89.47*",
      "Tue, Sep 29, 2026",
      "*The amount above may not reflect the final amount",
    ].join("\n");
    const r = parseTransaction(subject, body);
    expect(r?.amount).toBe(89.47);
    expect(r?.merchant).toBe("AMAZON.COM");
  });
});
