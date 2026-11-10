import Foundation
import Capacitor
import BackgroundTasks
import WidgetKit

/// The app's own native plugin (plan/38, apps/web/src/platform/native/device-plugin.ts): foreground downloads
/// that can be cancelled on the wire, the state the background job needs, and the widget's snapshot.
@objc(PurssDevicePlugin)
public class PurssDevicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PurssDevicePlugin"
    public let jsName = "PurssDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBackground", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeBackgroundReport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
    ]

    private lazy var downloads = ForegroundDownloads { [weak self] id, bytes, total in
        self?.notifyListeners("progress", data: ["id": id, "bytes": bytes, "total": total])
    }

    @objc func download(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty,
              let urlString = call.getString("url"), let url = URL(string: urlString),
              let path = call.getString("path") else {
            call.reject("A download needs an id, an address and a path.", "io")
            return
        }
        // The plugin's own rules, whatever the page asks: https only, and never more than the largest download.
        guard url.scheme?.lowercased() == "https" else {
            call.reject("Only https addresses are downloaded.", "insecure")
            return
        }
        guard let destination = ForegroundDownloads.destination(for: path) else {
            call.reject("The path must be relative, without empty segments or '..'.", "io")
            return
        }
        let largest: Int64 = 4 * 1024 * 1024 * 1024 // MAX_DOWNLOAD_BYTES
        var maxBytes = largest
        if let n = call.options["maxBytes"] as? NSNumber, n.int64Value > 0 { maxBytes = min(n.int64Value, largest) }
        guard DeviceStore.ensureDirectory(DeviceStore.downloadsDirectory) else {
            call.reject("The downloads folder can't be created.", "io")
            return
        }
        downloads.start(id: id, url: url, destination: destination, maxBytes: maxBytes, call: call)
    }

    @objc func cancel(_ call: CAPPluginCall) {
        if let id = call.getString("id") { downloads.cancel(id: id) }
        call.resolve()
    }

    @objc func setBackground(_ call: CAPPluginCall) {
        guard let json = call.getString("state") else {
            DeviceStore.clearState()
            BackgroundJob.cancelRequest()
            call.resolve()
            return
        }
        guard DeviceStore.storeState(json: json) else {
            call.reject("The background state can't be read.", "io")
            return
        }
        BackgroundJob.schedule()
        call.resolve()
    }

    @objc func setWidget(_ call: CAPPluginCall) {
        do {
            if let json = call.getString("snapshot") {
                try DeviceStore.writeWidget(json.data(using: .utf8))
            } else {
                try DeviceStore.writeWidget(nil)
            }
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "io")
        }
    }

    @objc func getWidget(_ call: CAPPluginCall) {
        if let url = DeviceStore.widgetFile, let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) {
            call.resolve(["snapshot": text])
        } else {
            call.resolve(["snapshot": NSNull()])
        }
    }

    @objc func takeBackgroundReport(_ call: CAPPluginCall) {
        call.resolve(["lost": DeviceStore.takeLost()])
    }

    @objc func reset(_ call: CAPPluginCall) {
        BackgroundJob.cancelRequest()
        DeviceStore.clearState()
        DeviceStore.clearLost()
        Task {
            await BackgroundTransfers.shared.cancelAllAndWait()
            try? FileManager.default.removeItem(at: DeviceStore.incomingDirectory)
            try? DeviceStore.writeWidget(nil)
            call.resolve()
        }
    }
}
