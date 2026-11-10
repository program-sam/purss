import Foundation
import Capacitor

/// Hands the page's notification target (PURSS address and fetch credential) to native code, which
/// keeps it in the Keychain for the notification extension. Permission and the APNs token come from
/// @capacitor/push-notifications.
@objc(PurssPushPlugin)
public class PurssPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PurssPushPlugin"
    public let jsName = "PurssPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "config", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTarget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearTarget", returnType: CAPPluginReturnPromise),
    ]

    private static let tokenPattern = try! NSRegularExpression(pattern: "^purss_push_[A-Za-z0-9_-]{43}$")

    @objc func config(_ call: CAPPluginCall) {
        call.resolve(["pushReady": true, "relay": "", "debugToken": ""])
    }

    @objc func setTarget(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"),
              let url = URL(string: origin), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else {
            call.reject("The PURSS address must be an http or https address.")
            return
        }
        guard let token = call.getString("fetchToken"),
              Self.tokenPattern.firstMatch(in: token, range: NSRange(token.startIndex..., in: token)) != nil else {
            call.reject("The notification credential is not valid.")
            return
        }
        if let message = PushTarget.save(PushTarget(origin: origin, fetchToken: token)) {
            call.reject(message)
            return
        }
        call.resolve()
    }

    @objc func clearTarget(_ call: CAPPluginCall) {
        if let message = PushTarget.delete() {
            call.reject(message)
            return
        }
        call.resolve()
    }
}
