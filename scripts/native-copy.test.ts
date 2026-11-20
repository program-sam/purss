import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { androidText, generate, placeholders } from "./native-copy.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = "apps/mobile/android/app/src";

function filesUnder(directory: string, ending: RegExp): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(relative, ending);
    return ending.test(entry.name) ? [relative] : [];
  });
}

test("the native files are what the catalog says (run npm run copy:native when this fails)", () => {
  for (const { file, text } of generate()) {
    assert.equal(readFileSync(path.join(root, file), "utf8"), text, `${file} is out of date: run npm run copy:native`);
  }
});

test("every Android string the app uses is written, and every one written is used", () => {
  const written = (file: string) => [...readFileSync(path.join(root, file), "utf8").matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]!);
  const copy = generate().filter((g) => g.file.endsWith(".xml")).flatMap((g) => [...g.text.matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]!));
  const defined = new Set([...copy, ...written(`${ANDROID}/main/res/values/app_identifiers.xml`)]);
  const used = new Set<string>();
  for (const file of filesUnder(ANDROID, /\.(kt|java|xml)$/)) {
    if (/\/(test|build)\//.test(file) || file.includes("/res/values/")) continue;
    const source = readFileSync(path.join(root, file), "utf8");
    for (const m of source.matchAll(/R\.string\.([a-z0-9_]+)|@string\/([a-z0-9_]+)/g)) used.add((m[1] ?? m[2])!);
  }
  assert.deepEqual([...used].filter((name) => !defined.has(name)), [], "used but not written");
  assert.deepEqual(copy.filter((name) => !used.has(name)), [], "written but not used (remove it from packages/copy/src/native/en/android.ts)");
});

test("an Android text is the catalog's with its values numbered by first appearance and what XML and aapt read specially escaped", () => {
  assert.equal(androidText("{done} of {total} MB"), "%1$s of %2$s MB");
  assert.equal(androidText("{title}, {meta} ({title})"), "%1$s, %2$s (%1$s)");
  assert.equal(androidText("You don't follow <this> & \"that\""), "You don\\'t follow &lt;this&gt; &amp; \\\"that\\\"");
  assert.equal(androidText("@home"), "\\@home");
  assert.throws(() => androidText("100%"), /%/);
});

test("a catalog text holds only {names} of lower-case letters and digits", () => {
  assert.deepEqual(placeholders("{host} ({os}) {host}"), ["host", "os"]);
  assert.deepEqual(placeholders("no values"), []);
  assert.throws(() => placeholders("{Host}"), /brace/);
  assert.throws(() => placeholders("a { b"), /brace/);
});

test("the desktop's Rust module has a constant for each plain text and a function for each text with values", () => {
  const rust = generate().find((g) => g.file.endsWith("copy.rs"))!.text;
  assert.match(rust, /pub const OPEN: &str = "Open PURSS";/);
  assert.match(rust, /pub fn restart\(version: impl std::fmt::Display\) -> String \{\n\s+format!\("Restart to update to \{version\}"\)/);
  assert.match(rust, /pub fn named\(host: impl std::fmt::Display, os: impl std::fmt::Display\) -> String/);
});
