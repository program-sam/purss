/**
 * Prices in the visitor's currency. We charge in euros; other currencies are shown as an approximation,
 * converted at the European Central Bank reference rates of one day. The visitor's currency is guessed
 * from the browser's time zone and language only: nothing is looked up or sent anywhere.
 */

/** ECB euro reference rates (units of each currency per €1), from https://www.ecb.europa.eu/stats/eurofxref/ */
export const ECB = {
  date: "2026-11-05",
  label: "5 November 2026",
  rates: {
    EUR: 1, USD: 1.1224, JPY: 177.85, CZK: 24.289, DKK: 7.4747, GBP: 0.83393, HUF: 363.18, PLN: 4.389, RON: 5.3385,
    SEK: 10.9845, CHF: 0.918, ISK: 136.8, NOK: 10.4365, TRY: 56.1729, AUD: 1.6033, BRL: 6.1355, CAD: 1.5675,
    CNY: 7.4846, HKD: 8.8055, IDR: 20281.15, ILS: 3.5598, INR: 106.0395, KRW: 1509.28, MXN: 20.8655, MYR: 4.5412,
    NZD: 1.9966, PHP: 70.706, SGD: 1.4336, THB: 37.533, ZAR: 18.4268,
  },
} as const;

export type Currency = keyof typeof ECB.rates;
export const CURRENCIES = Object.keys(ECB.rates) as Currency[];
const isCurrency = (c: string): c is Currency => c in ECB.rates;

/** A price as a company lists it. */
export type Money = { amount: number; cur: Currency };

const fmt = (amount: number, cur: Currency) =>
  new Intl.NumberFormat("en", { style: "currency", currency: cur, trailingZeroDisplay: "stripIfInteger" }).format(amount);

/** `money` in `to`: exact when it is listed in that currency, otherwise converted and marked with ≈. */
export function show(money: Money, to: Currency): string {
  if (money.cur === to) return fmt(money.amount, to);
  return `≈&nbsp;${fmt((money.amount / ECB.rates[money.cur]) * ECB.rates[to], to)}`;
}

/** A display currency's name, such as "US dollar (USD)". */
export const currencyName = (cur: Currency) => `${new Intl.DisplayNames("en", { type: "currency" }).of(cur) ?? cur} (${cur})`;

/** Countries whose own currency has an ECB rate; any other country sees euros. */
const BY_COUNTRY: Record<string, Currency> = {
  US: "USD", PR: "USD", JP: "JPY", CZ: "CZK", DK: "DKK", GB: "GBP", HU: "HUF", PL: "PLN", RO: "RON", SE: "SEK", CH: "CHF",
  LI: "CHF", IS: "ISK", NO: "NOK", TR: "TRY", AU: "AUD", BR: "BRL", CA: "CAD", CN: "CNY", HK: "HKD", ID: "IDR", IL: "ILS",
  IN: "INR", KR: "KRW", MX: "MXN", MY: "MYR", NZ: "NZD", PH: "PHP", SG: "SGD", TH: "THB", ZA: "ZAR",
};

/** Time zones of those countries. A time zone says more about where someone is than their browser's language does. */
const BY_ZONE: Record<string, string> = {
  "Europe/London": "GB", "Europe/Belfast": "GB", "Europe/Zurich": "CH", "Europe/Vaduz": "LI", "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Warsaw": "PL", "Europe/Prague": "CZ", "Europe/Budapest": "HU",
  "Europe/Bucharest": "RO", "Atlantic/Reykjavik": "IS", "Europe/Istanbul": "TR", "Asia/Istanbul": "TR",
  "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Shanghai": "CN", "Asia/Urumqi": "CN", "Asia/Hong_Kong": "HK",
  "Asia/Jakarta": "ID", "Asia/Makassar": "ID", "Asia/Jayapura": "ID", "Asia/Jerusalem": "IL", "Asia/Tel_Aviv": "IL",
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Kuala_Lumpur": "MY", "Asia/Kuching": "MY", "Asia/Manila": "PH",
  "Asia/Singapore": "SG", "Asia/Bangkok": "TH", "Africa/Johannesburg": "ZA", "Pacific/Auckland": "NZ",
  "America/Sao_Paulo": "BR", "America/Bahia": "BR", "America/Fortaleza": "BR", "America/Recife": "BR", "America/Belem": "BR",
  "America/Manaus": "BR", "America/Mexico_City": "MX", "America/Monterrey": "MX", "America/Merida": "MX",
  "America/Cancun": "MX", "America/Chihuahua": "MX", "America/Hermosillo": "MX", "America/Tijuana": "MX",
  "America/Toronto": "CA", "America/Montreal": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Winnipeg": "CA", "America/Regina": "CA", "America/Halifax": "CA", "America/St_Johns": "CA",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
  "America/Phoenix": "US", "America/Anchorage": "US", "America/Detroit": "US", "America/Boise": "US",
  "America/Puerto_Rico": "PR", "Pacific/Honolulu": "US",
};

/** The currency to show by default, from a time zone and the browser's languages; euros when unsure. */
export function guessCurrency(zone: string | undefined, languages: readonly string[]): Currency {
  if (zone) {
    if (zone.startsWith("Australia/")) return "AUD";
    if (zone.startsWith("America/Indiana/") || zone.startsWith("America/Kentucky/") || zone.startsWith("America/North_Dakota/")) return "USD";
    const country = BY_ZONE[zone];
    if (country) return BY_COUNTRY[country]!;
    // Other European zones are in or next to the euro area; there, the euro is the right guess.
    if (zone.startsWith("Europe/")) return "EUR";
  }
  for (const lang of languages) {
    try {
      const region = new Intl.Locale(lang).maximize().region;
      if (region) return BY_COUNTRY[region] ?? "EUR";
    } catch { /* not a valid language tag */ }
  }
  return "EUR";
}

const KEY = "purss-currency";

/** Shows every price on the page in the visitor's currency, and lets them choose another one. */
export function mountCurrency(root: ParentNode = document): void {
  const pick = root.querySelector<HTMLSelectElement>("#currency");
  if (!pick) return;
  const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  const initial = saved && isCurrency(saved) ? saved : guessCurrency(Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages ?? [navigator.language]);
  const apply = (to: Currency) => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-money]")) {
      const [amount, cur] = el.dataset.money!.split(" ");
      // "approx" prices are ours: shown in euros, with the converted amount only for other currencies.
      el.innerHTML = el.dataset.approx !== undefined
        ? (to === "EUR" ? "" : `${show({ amount: Number(amount), cur: cur as Currency }, to)}${el.dataset.suffix ?? ""}`)
        : `${show({ amount: Number(amount), cur: cur as Currency }, to)}${el.dataset.suffix ?? ""}`;
    }
  };
  pick.value = initial;
  pick.closest<HTMLElement>(".s-cur")!.hidden = false;
  apply(initial);
  pick.addEventListener("change", () => {
    const to = pick.value as Currency;
    try { localStorage.setItem(KEY, to); } catch { /* storage unavailable */ }
    apply(to);
  });
}
