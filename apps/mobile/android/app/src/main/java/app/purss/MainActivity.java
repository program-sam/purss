package app.purss;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import app.purss.device.PurssDevicePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (plan/38): downloads that can be stopped, background downloads, the widget.
        registerPlugin(PurssDevicePlugin.class);
        // Notifications from the push relay (plan/37).
        registerPlugin(PurssPushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
