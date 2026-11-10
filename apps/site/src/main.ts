import "./styles.ts";
import { home } from "./home.ts";
import "./menu.ts";
import { mountCurrency } from "./currency.ts";
import { pickDesktopDownload } from "./desktop.ts";

// The page's HTML is rendered at build time; this makes the views demo interactive and shows prices in the visitor's currency.
home.mount(document.getElementById("root")!);
mountCurrency();
pickDesktopDownload(document, navigator);
