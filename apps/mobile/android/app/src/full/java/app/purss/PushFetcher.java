package app.purss;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import app.purss.device.BackgroundLogic;

/**
 * Notifications on this phone (plan/37). A push from the relay carries nothing but "something new"; this
 * fetches the texts from the connected PURSS with the phone's fetch credential (which reaches only this
 * phone's waiting notifications, never the account) and shows each as a system notification. Tapping one
 * opens purss://open with its item and source, which the app only navigates to.
 */
public final class PushFetcher {

    private static final String TAG = "PurssPush";
    static final String CHANNEL = "workspace";
    private static final int MAX_BYTES = 64 * 1024;

    private PushFetcher() {}

    /** Fetch what is waiting and show it. Blocks: call it off the main thread. Never throws. */
    static void fetchAndShow(Context ctx) {
        String origin = PushTarget.origin(ctx);
        String token = PushTarget.fetchToken(ctx);
        if (origin == null || token == null) return;
        // Not allowed to show anything: leave the notifications waiting rather than take them unseen.
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(origin + "/api/push/pending").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setDoOutput(true);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            try (OutputStream out = c.getOutputStream()) {
                out.write("{}".getBytes(StandardCharsets.UTF_8));
            }
            int status = c.getResponseCode();
            if (status == 401 && BackgroundLogic.refusedWith(readError(c), "push_signed_out")) {
                // This phone's registration is gone; the app registers again when it next starts. Any other 401 is transient.
                PushTarget.clear(ctx);
                return;
            }
            if (status != 200) {
                Log.w(TAG, "The workspace answered " + status + " when asked for notifications.");
                return;
            }
            JSONArray list = new JSONObject(read(c.getInputStream())).getJSONArray("notifications");
            if (list.length() == 0) return;
            ensureChannel(ctx);
            for (int i = 0; i < list.length(); i++) show(ctx, list.getJSONObject(i));
        } catch (Exception e) {
            Log.w(TAG, "Couldn't fetch notifications from the workspace: " + e.getClass().getSimpleName());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readError(HttpURLConnection c) {
        try {
            InputStream err = c.getErrorStream();
            return err == null ? null : read(err);
        } catch (Exception e) {
            return null;
        }
    }

    private static String read(InputStream in) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = s.read(chunk)) != -1) {
                if (buf.size() + n > MAX_BYTES) throw new IllegalStateException("answer too large");
                buf.write(chunk, 0, n);
            }
            return buf.toString("UTF-8");
        }
    }

    private static String text(JSONObject o, String key, int max) {
        if (o.isNull(key)) return null;
        String v = o.optString(key, "").trim();
        if (v.isEmpty()) return null;
        return v.length() > max ? v.substring(0, max) : v;
    }

    private static void show(Context ctx, JSONObject n) {
        String id = text(n, "id", 64);
        String title = text(n, "title", 200);
        if (id == null || title == null) return;
        String body = text(n, "body", 1000);
        Uri.Builder link = new Uri.Builder().scheme("purss").authority("open");
        String item = text(n, "itemId", 64);
        String source = text(n, "sourceId", 64);
        if (item != null) link.appendQueryParameter("item", item);
        if (source != null) link.appendQueryParameter("source", source);
        Intent open = new Intent(Intent.ACTION_VIEW, link.build()).setPackage(ctx.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(ctx, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        // On a locked screen that hides contents, only this shows.
        NotificationCompat.Builder hidden = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_workspace)
            .setContentTitle(ctx.getString(R.string.app_name))
            .setContentText(ctx.getString(R.string.push_hidden_text));
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_workspace)
            .setContentTitle(title)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(hidden.build())
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        if (body != null) b.setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        try {
            // One per notification: a notification that grew ("3 new from …") replaces the one shown before.
            NotificationManagerCompat.from(ctx).notify(id, 0, b.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notifications aren't allowed.");
        }
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager m = ctx.getSystemService(NotificationManager.class);
        if (m == null || m.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, ctx.getString(R.string.push_channel_name), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(ctx.getString(R.string.push_channel_description));
        m.createNotificationChannel(ch);
    }
}
