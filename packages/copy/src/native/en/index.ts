/**
 * Copy for the native shells: the Android app's string resources, the iOS widgets' and notification extension's Swift,
 * and the desktop app's Rust code; `widget` is the widgets' text both phones show. A value is a plain
 * string; `{name}` stands for a value the code fills in. scripts/native-copy.ts writes the platforms' own files from
 * it (npm run copy:native), and a test fails when one is out of date.
 */
import android from "./android.ts";
import desktop from "./desktop.ts";
import ios from "./ios.ts";
import widget from "./widget.ts";

export const native = {
  android,
  widget,
  ios,
  desktop,
};
