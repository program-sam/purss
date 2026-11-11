package app.purss;

import android.os.Bundle;
import app.purss.device.PurssDevicePlugin;
import com.getcapacitor.BridgeActivity;

/** Shared native registrations used by both Android distributions. */
public class PurssBaseActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PurssDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
