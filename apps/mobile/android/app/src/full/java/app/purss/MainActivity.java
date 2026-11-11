package app.purss;

import android.os.Bundle;

public class MainActivity extends PurssBaseActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Notifications from the push relay (plan/37).
        registerPlugin(PurssPushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
