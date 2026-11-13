package app.purss.device

import android.os.Build
import app.purss.BuildConfig
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The app's own plugin (plan/38; the page's side is apps/web/src/platform/native/device-plugin.ts):
 * downloads that stop on the wire when cancelled, the background job's state, the home-screen panels'
 * look and episode and their refresh, and where the app was installed from.
 */
@CapacitorPlugin(name = "PurssDevice")
class PurssDevicePlugin : Plugin() {
    private val transfers = ConcurrentHashMap<String, Transfer>()
    private val pool = Executors.newCachedThreadPool()

    override fun load() {
        DeviceStore.appVisible = true
    }

    override fun handleOnStart() {
        DeviceStore.appVisible = true
        // The open app downloads by itself: a background transfer running now stops and is offered again later.
        BackgroundDownloadWorker.current?.cancel()
    }

    override fun handleOnStop() {
        DeviceStore.appVisible = false
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val id = call.getString("id")
        val url = call.getString("url")
        val dest = call.getString("path")?.let { Paths.under(DeviceStore.downloadsRoot(context), it) }
        if (id.isNullOrEmpty() || url.isNullOrEmpty() || dest == null) {
            call.reject("A download needs an id, a web address and a path inside the downloads folder.", "io")
            return
        }
        // The plugin's own rules, whatever the page asks: https only, and never more than the largest download.
        if (!BackgroundLogic.downloadAllowed(url)) {
            call.reject("Only https addresses are downloaded.", "insecure")
            return
        }
        val max = BackgroundLogic.downloadCap(call.getLong("maxBytes"))
        val transfer = Transfer(url, dest, max, onProgress = { bytes, total ->
            notifyListeners("progress", JSObject().put("id", id).put("bytes", bytes).put("total", total))
        })
        transfers[id] = transfer
        pool.execute {
            try {
                val bytes = transfer.run()
                call.resolve(JSObject().put("bytes", bytes))
            } catch (e: TransferFailure) {
                val data = JSObject()
                if (e.code == "http") data.put("status", e.status)
                call.reject(e.message, e.code, null, data)
            } finally {
                transfers.remove(id)
            }
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        call.getString("id")?.let { transfers[it]?.cancel() }
        call.resolve()
    }

    @PluginMethod
    fun setBackground(call: PluginCall) {
        val state = call.getString("state")
        if (state == null || BackgroundLogic.parseState(state) == null) {
            BackgroundDownloads.cancel(context)
            DeviceStore.setBackground(context, null)
        } else {
            DeviceStore.setBackground(context, state)
            BackgroundDownloads.schedule(context)
        }
        call.resolve()
    }

    @PluginMethod
    fun setWidget(call: PluginCall) {
        // After a refusal the page may run on until it next starts: nothing it writes of the refused account is kept.
        synchronized(WidgetData.lock) { if (!DeviceStore.isLost(context)) DeviceStore.setWidget(context, call.getString("snapshot")) }
        DeviceStore.pageAlive = true
        Panels.redrawAll(context)
        call.resolve()
    }

    /** The page's items changed or it started: the panels' lists are fetched again soon (WidgetRefresh). */
    @PluginMethod
    fun refreshWidgets(call: PluginCall) {
        WidgetRefresh.soon(context)
        call.resolve()
    }

    @PluginMethod
    fun getWidget(call: PluginCall) {
        call.resolve(JSObject().put("snapshot", DeviceStore.widget(context) ?: JSObject.NULL))
    }

    @PluginMethod
    fun takeBackgroundReport(call: PluginCall) {
        call.resolve(JSObject().put("lost", DeviceStore.takeLost(context)))
    }

    /** The build's flavor and the app that installed it (null for a file installed by hand or with adb), so the page knows where updates of the app come from. */
    @PluginMethod
    fun installSource(call: PluginCall) {
        val installer = try {
            val pm = context.packageManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) pm.getInstallSourceInfo(context.packageName).installingPackageName
            else @Suppress("DEPRECATION") pm.getInstallerPackageName(context.packageName)
        } catch (_: Exception) {
            null
        }
        call.resolve(JSObject().put("flavor", BuildConfig.FLAVOR).put("installer", installer ?: JSObject.NULL))
    }

    @PluginMethod
    fun reset(call: PluginCall) {
        DeviceStore.pageAlive = false
        BackgroundDownloads.forget(context, downloadsToo = false)
        DeviceStore.takeLost(context)
        call.resolve()
    }

    override fun handleOnDestroy() {
        for (t in transfers.values) t.cancel()
        pool.shutdown()
    }
}
