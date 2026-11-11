package app.purss;

import android.content.Context;
import android.content.SharedPreferences;

/** The notification fetch credential, kept only on this device with backups off. */
public final class PushTarget {
    private static final String PREFS = "purss_push";
    private static final String KEY_ORIGIN = "origin";
    private static final String KEY_TOKEN = "fetchToken";

    private PushTarget() {}

    public static void set(Context context, String origin, String fetchToken) {
        prefs(context).edit().putString(KEY_ORIGIN, origin).putString(KEY_TOKEN, fetchToken).commit();
    }

    public static void clear(Context context) {
        prefs(context).edit().clear().commit();
    }

    static String origin(Context context) {
        return prefs(context).getString(KEY_ORIGIN, null);
    }

    static String fetchToken(Context context) {
        return prefs(context).getString(KEY_TOKEN, null);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
