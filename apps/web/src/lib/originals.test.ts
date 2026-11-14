import test from "node:test";
import assert from "node:assert/strict";
import { addressParts, placeWebView } from "./originals.ts";

const pane = { x: 600, y: 90, width: 500, height: 700 };

test("the web view takes the pane's place, hides under a menu or dialog, and ends above a message at the bottom", () => {
  assert.deepEqual(placeWebView(pane, []), pane);
  // A menu opening from the bar above, into the pane.
  assert.equal(placeWebView(pane, [{ x: 700, y: 60, width: 220, height: 300 }]), null);
  // A dialog's full-screen backdrop.
  assert.equal(placeWebView(pane, [{ x: 0, y: 0, width: 1200, height: 800 }]), null);
  // A message near the bottom: the view ends above it.
  assert.deepEqual(placeWebView(pane, [{ x: 612, y: 700, width: 400, height: 44 }]), { ...pane, height: 700 - 6 - 90 });
  // Elsewhere on screen (the list's message at the bottom left, a menu in the sidebar): no change.
  assert.deepEqual(placeWebView(pane, [{ x: 16, y: 700, width: 380, height: 44 }, { x: 0, y: 100, width: 200, height: 300 }, { x: 600, y: 300, width: 0, height: 0 }]), pane);
  // Too little left to be worth showing.
  assert.equal(placeWebView({ ...pane, height: 200 }, [{ x: 600, y: 200, width: 500, height: 40 }]), null);
});

test("the bar shows the site first, then the rest of the address, and says when it isn't encrypted", () => {
  assert.deepEqual(addressParts("https://www.example.org/2026/a-story?x=1"), { site: "example.org", rest: "/2026/a-story?x=1", secure: true });
  assert.deepEqual(addressParts("http://blog.example:8080/"), { site: "blog.example:8080", rest: "", secure: false });
});
