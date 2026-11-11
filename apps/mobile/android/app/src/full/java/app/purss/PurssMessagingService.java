package app.purss;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Receives the relay's pushes (data messages with no content) in place of the push plugin's own service,
 * which it extends so new push addresses still reach the app's page. Runs even when the app is closed.
 */
public class PurssMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        if ("1".equals(message.getData().get("purss"))) PushFetcher.fetchAndShow(this);
    }
}
