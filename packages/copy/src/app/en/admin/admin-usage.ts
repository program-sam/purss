export default {
  intro: "Compares each account's recorded usage with what it actually stores. It only reports differences and changes nothing.",
  checking: "Checking…",
  run: "Run usage check",
  account: "account",
  differs: (accounts: string, total: number, mismatched: number) => `${accounts} of ${total} ${mismatched === 1 ? "differs" : "differ"}.`,
  allMatch: (accounts: string) => `All ${accounts} match.`,
  checked: (when: string) => ` Checked ${when}.`,
  justNow: "just now",
  accountId: (id: string) => `Account ${id}`,
  ledger: (ledger: string, stored: string) => `Ledger ${ledger} · stored ${stored}`,
  matches: "Matches",
  disagree: "A difference means recorded usage and stored items disagree. Nothing was changed.",
};
