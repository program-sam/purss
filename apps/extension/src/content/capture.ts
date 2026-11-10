import { readableOf } from "../lib/capture.ts";

// Injected only when the person asks to keep the page's text: the popup then calls this to read the
// readable part of the page as it is shown now.
(globalThis as { __purssReadable?: () => unknown }).__purssReadable = () => readableOf(document);
