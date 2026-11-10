import UIKit
import UniformTypeIdentifiers

/// The iOS share extension: hands a shared link (or text) to the app through the app group, where
/// @capgo/capacitor-share-target reads it, then opens the app at purss://share. The app asks whether to
/// keep the link or add it as a source; nothing is sent anywhere from here.
class ShareViewController: UIViewController {
    /// Must match `plugins.CapacitorShareTarget.appGroupId` in capacitor.config.ts and both targets' entitlements.
    private let appGroupId = "group.app.purss"
    private let appURL = URL(string: "purss://share")!

    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await handOver() }
    }

    private func handOver() async {
        let item = extensionContext?.inputItems.first as? NSExtensionItem
        var texts: [String] = []
        for provider in item?.attachments ?? [] {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
               url.scheme == "https" || url.scheme == "http" {
                texts.append(url.absoluteString)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                texts.append(text)
            }
        }
        if !texts.isEmpty, let defaults = UserDefaults(suiteName: appGroupId) {
            let title = item?.attributedContentText?.string ?? item?.attributedTitle?.string ?? ""
            defaults.set(["title": title, "texts": texts, "files": [[String: Any]]()], forKey: "share-target-data")
        }
        openApp()
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Extensions can't call UIApplication.shared; the app is opened through the responder chain. If that
    /// isn't possible, the app still finds the link the next time it comes to the front.
    private func openApp() {
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(appURL, options: [:], completionHandler: nil)
                return
            }
            responder = r.next
        }
    }
}
