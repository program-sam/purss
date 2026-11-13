package app.purss.device

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File
import java.io.IOException
import java.util.Date
import java.util.concurrent.TimeUnit

/**
 * Automatic downloads while the app is closed (plan/38): a periodic WorkManager job. It asks the
 * PURSS which items to fetch (the same plan the open app asks for), fetches each item's details,
 * notes and file into `downloads-incoming/`, writes record.json last and moves the folder into the
 * downloads folder, where the page adopts it as its own download. It keeps out of the way while the app
 * is on screen. The home-screen panels have their own refresh (WidgetRefresh).
 */
object BackgroundDownloads {
    const val WORK = "purss-background-downloads"

    /** Every hour while connected, battery not low and storage not low. Kept as it is when already scheduled. */
    fun schedule(ctx: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .setRequiresStorageNotLow(true)
            .build()
        val request = PeriodicWorkRequestBuilder<BackgroundDownloadWorker>(1, TimeUnit.HOURS).setConstraints(constraints).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
    }

    /** Held while a finished item moves into the downloads folder and while forget() wipes, so neither sees half of the other. */
    val moving = Any()

    /** Disconnected, or the token was refused: nothing of the account stays with the native side. */
    fun forget(ctx: Context, downloadsToo: Boolean) {
        cancel(ctx)
        WidgetRefresh.cancel(ctx)
        BackgroundDownloadWorker.current?.cancel()
        synchronized(moving) {
            DeviceStore.setBackground(ctx, null)
            DeviceStore.incomingRoot(ctx).deleteRecursively()
            if (downloadsToo) DeviceStore.downloadsRoot(ctx).deleteRecursively()
        }
        WidgetData.wipe(ctx)
        Panels.redrawAll(ctx)
    }
}

class BackgroundDownloadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object {
        private const val TAG = "PurssBackground"
        /** The transfer running now, so the app coming to the front or a reset can stop it. */
        @Volatile var current: Transfer? = null
    }

    private val ctx get() = applicationContext

    override fun onStopped() {
        current?.cancel()
    }

    private fun yielding() = isStopped || DeviceStore.appVisible

    override fun doWork(): Result {
        val since = WidgetData.generation
        if (DeviceStore.appVisible) { Log.i(TAG, "The app is open; it downloads by itself"); return Result.success() }
        val conn = StoredConnection.read(ctx)
        if (conn == null) {
            Log.i(TAG, "Not connected; nothing to do")
            // Nothing connected (or the page removed the token): nothing to keep for it.
            BackgroundDownloads.forget(ctx, downloadsToo = false)
            return Result.success()
        }
        val state = BackgroundLogic.parseState(DeviceStore.background(ctx))
        if (state == null || state.origin != conn.origin) { Log.i(TAG, "No download settings for this connection"); return Result.success() }
        val api = WorkspaceApi(conn)
        try {
            if (!state.wantsDownloads || yielding()) return Result.success()
            if (state.wifiOnly && !onWifi()) { Log.i(TAG, "Waiting for Wi-Fi"); return Result.success() }
            val plan = api.post("/api/downloads/plan", BackgroundLogic.planRequest(state))
            if (plan.status != 200) { Log.i(TAG, "The workspace answered ${plan.status} to the plan"); return Result.success() }
            val items = BackgroundLogic.parsePlan(plan.text)
            Log.i(TAG, "${items.size} to download")
            var done = 0
            for (item in items) {
                if (yielding()) break
                if (!fetch(api, state.accountId, item)) break
                done++
            }
            Log.i(TAG, "Finished $done of ${items.size}")
        } catch (e: Refused) {
            Log.i(TAG, "The workspace refused the token; removing what the app kept")
            WidgetData.lost(ctx, since)
        } catch (e: Exception) {
            // Offline or the PURSS is busy: the next run tries again.
            Log.i(TAG, "Background downloads stopped: ${e.javaClass.simpleName}")
        }
        return Result.success()
    }

    private fun onWifi(): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    /**
     * One item, as the page's download manager does it. Returns false when the run should stop (the app
     * came to the front, the job was stopped, the PURSS or the device couldn't go on); the item then
     * leaves nothing behind and is offered again next time.
     */
    private fun fetch(api: WorkspaceApi, accountId: String, item: BackgroundLogic.PlanItem): Boolean {
        val staging = File(DeviceStore.incomingRoot(ctx), "$accountId/${item.id}")
        val target = File(DeviceStore.downloadsRoot(ctx), "$accountId/${item.id}")
        staging.deleteRecursively()
        if (target.exists()) return true
        if (!staging.mkdirs()) return false
        try {
            val detailAnswer = api.get("/api/items/${WorkspaceApi.enc(item.id)}")
            if (detailAnswer.status == 404) { staging.deleteRecursively(); return true }
            if (detailAnswer.status != 200) { staging.deleteRecursively(); return false }
            File(staging, "item.json").writeBytes(detailAnswer.body)
            var textBytes = detailAnswer.body.size.toLong()
            val detail = BackgroundLogic.parseDetail(detailAnswer.text)
            if (detail.annotated) {
                val notes = api.get("/api/items/${WorkspaceApi.enc(item.id)}/annotations")
                if (notes.status != 200) { staging.deleteRecursively(); return false }
                File(staging, "annotations.json").writeBytes(notes.body)
                textBytes += notes.body.size
            }
            val state = BackgroundLogic.parseState(DeviceStore.background(ctx)) ?: run { staging.deleteRecursively(); return false }
            val room = state.room
            var mediaBytes = 0L
            var failure: Int? = when {
                item.declaredBytes != null && item.declaredBytes > room -> -2
                !item.url.startsWith("https://", ignoreCase = true) -> -1
                else -> null
            }
            if (failure == null) {
                val transfer = Transfer(item.url, File(staging, item.file), room, shouldStop = ::yielding)
                current = transfer
                try {
                    mediaBytes = transfer.run()
                } catch (e: TransferFailure) {
                    Log.i(TAG, "A file didn't download: ${e.code} ${e.status} ${e.message}")
                    failure = when (e.code) {
                        "cancelled", "io" -> { staging.deleteRecursively(); return false }
                        "too_large" -> -2
                        "http" -> e.status
                        else -> 0
                    }
                } finally {
                    current = null
                }
            }
            // A failed download keeps only its record: the page shows why, and it is tried again only by hand.
            if (failure != null) staging.listFiles()?.forEach { it.deleteRecursively() }
            val record = if (failure == null) BackgroundLogic.doneRecord(accountId, item.id, detail, item, mediaBytes, textBytes, Date())
            else BackgroundLogic.failedRecord(item.id, detail, failure, Date())
            File(staging, "record.json").writeText(record)
            // Into the downloads folder only while the state still names this account (a disconnect may have wiped
            // everything during the transfer), the job wasn't stopped, and the page hasn't downloaded it meanwhile.
            synchronized(BackgroundDownloads.moving) {
                if (!BackgroundLogic.mayKeep(DeviceStore.background(ctx), accountId, isStopped)) { staging.deleteRecursively(); return false }
                target.parentFile?.mkdirs()
                if (target.exists() || !staging.renameTo(target)) { staging.deleteRecursively(); return true }
                DeviceStore.background(ctx)?.let { DeviceStore.setBackground(ctx, BackgroundLogic.afterDownload(it, item.id, if (failure == null) mediaBytes + textBytes else 0L)) }
            }
            return true
        } catch (e: Refused) {
            staging.deleteRecursively()
            throw e
        } catch (e: IOException) {
            staging.deleteRecursively()
            return false
        }
    }
}
