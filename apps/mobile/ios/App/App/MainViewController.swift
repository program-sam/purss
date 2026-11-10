import UIKit
import Capacitor

/// The app's bridge view controller: registers the plugins that live in this project (local plugins are not
/// found by `cap sync`): downloads, background work and the widget (plan/38), and notifications (plan/37).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PurssDevicePlugin())
        bridge?.registerPluginInstance(PurssPushPlugin())
    }
}
