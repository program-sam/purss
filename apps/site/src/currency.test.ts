import assert from "node:assert/strict";
import test from "node:test";
import { ECB, guessCurrency, show } from "./currency.ts";

test("a price listed in the shown currency is exact; any other is converted at the ECB rate and marked", () => {
  assert.equal(show({ amount: 6.99, cur: "EUR" }, "EUR"), "€6.99");
  assert.equal(show({ amount: 4, cur: "EUR" }, "EUR"), "€4");
  assert.equal(show({ amount: 9.99, cur: "USD" }, "USD"), "$9.99");
  assert.equal(show({ amount: 9.99, cur: "USD" }, "EUR"), "≈&nbsp;€8.90");
  assert.equal(show({ amount: 4, cur: "EUR" }, "USD"), `≈&nbsp;$${(4 * ECB.rates.USD).toFixed(2)}`);
  // Converting between two non-euro currencies goes through the euro.
  assert.equal(show({ amount: 12.99, cur: "USD" }, "GBP"), `≈&nbsp;£${((12.99 / ECB.rates.USD) * ECB.rates.GBP).toFixed(2)}`);
  assert.match(show({ amount: 5, cur: "EUR" }, "JPY"), /^≈&nbsp;¥\d{3}$/);
});

test("the time zone decides before the browser's language, and unknown places see euros", () => {
  assert.equal(guessCurrency("Europe/Amsterdam", ["en-US"]), "EUR");
  assert.equal(guessCurrency("Europe/London", ["nl-NL"]), "GBP");
  assert.equal(guessCurrency("America/New_York", ["de-DE"]), "USD");
  assert.equal(guessCurrency("America/Indiana/Indianapolis", []), "USD");
  assert.equal(guessCurrency("America/Toronto", ["en-US"]), "CAD");
  assert.equal(guessCurrency("Australia/Sydney", ["en-GB"]), "AUD");
  assert.equal(guessCurrency("Asia/Tokyo", []), "JPY");
  // No known zone: the language's region, else euros.
  assert.equal(guessCurrency("Etc/UTC", ["en-GB"]), "GBP");
  assert.equal(guessCurrency(undefined, ["en"]), "USD");
  assert.equal(guessCurrency("Africa/Lagos", ["en-NG"]), "EUR");
  assert.equal(guessCurrency(undefined, ["not a tag", "sv-SE"]), "SEK");
  assert.equal(guessCurrency(undefined, []), "EUR");
});
