package app.purss;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;
import java.util.regex.Pattern;

/**
 * What the page hands to the native notification code (plan/37): the PURSS and the fetch credential
 * PushFetcher uses when a push arrives. Also says whether this build can receive pushes: it needs its
 * Firebase setup (google-services.json), which a build made without it doesn't have.
 */
@CapacitorPlugin(name = "PurssPush")
public class PurssPushPlugin extends Plugin {

    private static final Pattern FETCH_TOKEN = Pattern.compile("^purss_push_[A-Za-z0-9_-]{43}$");
    private static final Pattern ORIGIN = Pattern.compile("^https?://[^/?#@\\s]+$");

    @PluginMethod
    public void config(PluginCall call) {
        // Debug builds only: a local relay and a stand-in push address, for trying the whole path without Firebase.
        // Release builds carry empty values (app/build.gradle).
        String relay = BuildConfig.DEBUG ? BuildConfig.PURSS_PUSH_RELAY : "";
        String debugToken = BuildConfig.DEBUG ? BuildConfig.PURSS_PUSH_DEBUG_TOKEN : "";
        JSObject out = new JSObject();
        out.put("pushReady", !FirebaseApp.getApps(getContext()).isEmpty() || !debugToken.isEmpty());
        out.put("relay", relay);
        out.put("debugToken", debugToken);
        call.resolve(out);
    }

    @PluginMethod
    public void setTarget(PluginCall call) {
        String origin = call.getString("origin", "");
        String token = call.getString("fetchToken", "");
        if (!ORIGIN.matcher(origin).matches() || !FETCH_TOKEN.matcher(token).matches()) {
            call.reject("That isn't a PURSS address and notification credential.");
            return;
        }
        PushFetcher.setTarget(getContext(), origin, token);
        call.resolve();
    }

    @PluginMethod
    public void clearTarget(PluginCall call) {
        PushFetcher.clearTarget(getContext());
        call.resolve();
    }
}
