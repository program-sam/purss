import { collectPageInfo } from "../lib/page-info.ts";

// Injected into the open page when the popup opens (activeTab), in the extension's isolated world:
// the popup then calls this to read the feeds or channel the page advertises.
(globalThis as { __purssPageInfo?: () => unknown }).__purssPageInfo = () => collectPageInfo(document, location.href);
