package app.purss;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Debug builds only: does what PurssMessagingService does when the relay's push arrives (see the debug manifest). */
public class DebugPushReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                PushFetcher.fetchAndShow(app);
            } finally {
                pending.finish();
            }
        }).start();
    }
}
