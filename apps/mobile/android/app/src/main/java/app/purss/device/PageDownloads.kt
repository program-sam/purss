package app.purss.device

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import app.purss.R
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The files the page asks for (`PurssDevice.download`), fetched by a WorkManager job that runs as a
 * foreground service with a notification, so a download goes on when the app is closed. What is asked
 * for is kept in the app's preferences until it ends, so a job the system stopped (or a process it
 * killed) runs again later and continues from the partial file (Transfer). The page asks again for
 * what it was waiting for when it next starts: a file finished meanwhile is answered at once, one under
 * way is joined, one cut off is continued.
 */
object PageDownloads {
    private const val TAG = "PurssDownloads"
    const val WORK = "purss-page-downloads"
    private const val PREFS = "purss.device"
    private const val KEY = "page-downloads"
    private const val CHANNEL = "purss-downloads"
    private const val NOTIFICATION = 7301
    /** Runs of the job after lost connections while the app isn't on screen; then the page decides when it next starts. */
    const val MAX_ATTEMPTS = 8

    class Entry(val path: String, val url: String, val maxBytes: Long)

    /** A page call waiting for a path: its progress events, then exactly one of done or failed. */
    class Waiter(
        val id: String,
        val onProgress: (bytes: Long, total: Long) -> Unit,
        val onDone: (bytes: Long) -> Unit,
        val onFailed: (TransferFailure) -> Unit,
    )

    /** Guards the kept entries, the waiters, `draining` and `running`. */
    private val lock = Any()
    private val waiters = HashMap<String, MutableList<Waiter>>()
    /** The job is in its loop and will take any entry added now. */
    private var draining = false
    private var running: Pair<String, Transfer>? = null

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun read(ctx: Context): MutableList<Entry> {
        val out = mutableListOf<Entry>()
        try {
            val a = JSONArray(prefs(ctx).getString(KEY, "[]"))
            for (i in 0 until a.length()) {
                val o = a.getJSONObject(i)
                out.add(Entry(o.getString("path"), o.getString("url"), o.getLong("maxBytes")))
            }
        } catch (_: Exception) { /* damaged: nothing kept */ }
        return out
    }

    private fun write(ctx: Context, entries: List<Entry>) {
        val a = JSONArray()
        for (e in entries) a.put(JSONObject().put("path", e.path).put("url", e.url).put("maxBytes", e.maxBytes))
        prefs(ctx).edit().apply { if (entries.isEmpty()) remove(KEY) else putString(KEY, a.toString()) }.commit()
    }

    /**
     * Fetch `url` into `path` (under the downloads folder) for `waiter`. A complete file already at `path`
     * answers at once; a transfer of `path` already asked for is joined.
     */
    fun start(ctx: Context, path: String, url: String, maxBytes: Long, waiter: Waiter) {
        val dest = Paths.under(DeviceStore.downloadsRoot(ctx), path) ?: return waiter.onFailed(TransferFailure("io", 0, "Not a path in the downloads folder"))
        var finished: Long? = null
        var tooLarge = false
        synchronized(lock) {
            val entries = read(ctx)
            if (dest.isFile && entries.none { it.path == path }) {
                if (dest.length() > maxBytes) { dest.delete(); tooLarge = true } else finished = dest.length()
            } else {
                waiters.getOrPut(path) { mutableListOf() }.add(waiter)
                if (entries.none { it.path == path }) { entries.add(Entry(path, url, maxBytes)); write(ctx, entries) }
                if (!draining) enqueue(ctx)
            }
        }
        if (tooLarge) waiter.onFailed(TransferFailure("too_large", 0, "Larger than allowed"))
        finished?.let { waiter.onDone(it) }
    }

    /**
     * Stop what was asked for under `name` (a path, a folder, "" for everything) or by a waiter with that
     * id: the connection closes and the partial files go. Its waiters hear "cancelled".
     */
    fun cancel(ctx: Context, name: String) {
        val told = mutableListOf<Waiter>()
        synchronized(lock) {
            val entries = read(ctx)
            val (gone, kept) = entries.partition { e -> matches(e.path, name) || waiters[e.path]?.any { it.id == name } == true }
            if (gone.isEmpty()) return
            write(ctx, kept)
            for (e in gone) {
                waiters.remove(e.path)?.let { told.addAll(it) }
                val r = running
                if (r != null && r.first == e.path) r.second.cancel(discard = true)
                else Paths.under(DeviceStore.downloadsRoot(ctx), e.path)?.let { dest ->
                    java.io.File(dest.path + ".part").delete()
                    java.io.File(dest.path + ".part.json").delete()
                }
            }
        }
        for (w in told) w.onFailed(TransferFailure("cancelled", 0, "Stopped"))
    }

    private fun matches(path: String, name: String) = name.isEmpty() || path == name || path.startsWith("$name/")

    /** The page in this process went away: its calls are dropped, the transfers go on. */
    fun detachAll() {
        synchronized(lock) { waiters.clear() }
    }

    /** Disconnected or refused: everything asked for stops and is forgotten. */
    fun forget(ctx: Context) {
        cancel(ctx, "")
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
    }

    private fun enqueue(ctx: Context) {
        val request = OneTimeWorkRequestBuilder<PageDownloadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        // Replace: a job that is ending (or waiting out a back-off) runs again at once for what was just asked.
        WorkManager.getInstance(ctx).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request)
    }

    // ---------- the job's side ----------

    internal fun beginDrain() = synchronized(lock) { draining = true }

    /** The next entry to fetch, or null (and the job no longer takes entries) when none is left. */
    internal fun next(ctx: Context): Entry? = synchronized(lock) {
        val e = read(ctx).firstOrNull()
        if (e == null) draining = false
        e
    }

    internal fun endDrain() = synchronized(lock) { draining = false }

    /** Marks `transfer` as the one running for `path`, unless the entry was cancelled since `next`. */
    internal fun claim(ctx: Context, path: String, transfer: Transfer): Boolean = synchronized(lock) {
        if (read(ctx).none { it.path == path }) return false
        running = path to transfer
        true
    }

    internal fun release() = synchronized(lock) { running = null }

    internal fun progress(path: String, bytes: Long, total: Long) {
        val list = synchronized(lock) { waiters[path]?.toList() } ?: return
        for (w in list) w.onProgress(bytes, total)
    }

    /** The entry ended: forgotten, and its waiters told. Nothing happens for one cancelled meanwhile. */
    internal fun finish(ctx: Context, path: String, bytes: Long?, failure: TransferFailure?) {
        val list = synchronized(lock) {
            val entries = read(ctx)
            if (entries.none { it.path == path }) return
            write(ctx, entries.filter { it.path != path })
            waiters.remove(path) ?: emptyList<Waiter>()
        }
        for (w in list) if (failure != null) w.onFailed(failure) else w.onDone(bytes ?: 0L)
    }

    /** The job gave up on lost connections: every entry ends as "network", its partial file kept for the page to continue. */
    internal fun giveUp(ctx: Context) {
        val entries = synchronized(lock) { read(ctx) }
        for (e in entries) finish(ctx, e.path, null, TransferFailure("network", 0, "The connection failed"))
    }

    fun foregroundInfo(ctx: Context, bytes: Long, total: Long): ForegroundInfo {
        val n = notification(ctx, bytes, total)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(NOTIFICATION, n)
    }

    fun showProgress(ctx: Context, bytes: Long, total: Long) {
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION, notification(ctx, bytes, total))
        } catch (_: SecurityException) { /* notifications not allowed: the download goes on unseen */ }
    }

    private fun notification(ctx: Context, bytes: Long, total: Long): android.app.Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm?.getNotificationChannel(CHANNEL) == null) {
                nm?.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.downloads_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                    description = ctx.getString(R.string.downloads_channel_description)
                })
            }
        }
        val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val tap = open?.let { PendingIntent.getActivity(ctx, NOTIFICATION, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_purss)
            .setContentTitle(ctx.getString(R.string.downloads_notification_title))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        if (tap != null) b.setContentIntent(tap)
        if (total > 0) {
            val pct = ((bytes.coerceAtMost(total) * 100) / total).toInt()
            b.setProgress(100, pct, false).setContentText(ctx.getString(R.string.downloads_notification_progress, megabytes(bytes), megabytes(total)))
        } else {
            b.setProgress(0, 0, true)
            if (bytes > 0) b.setContentText(ctx.getString(R.string.downloads_notification_bytes, megabytes(bytes)))
        }
        return b.build()
    }

    private fun megabytes(bytes: Long): String = String.format(java.util.Locale.ROOT, "%.1f", bytes / 1_000_000.0)

    internal fun log(message: String) = Log.i(TAG, message)
}

class PageDownloadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    @Volatile private var current: Transfer? = null
    private var shown = 0L

    private val ctx get() = applicationContext

    override fun getForegroundInfo(): ForegroundInfo = PageDownloads.foregroundInfo(ctx, 0, -1)

    override fun onStopped() {
        // Stopped by the system (its time limit, the network going): the partial file waits for the next run.
        current?.cancel(discard = false)
    }

    override fun doWork(): Result {
        PageDownloads.beginDrain()
        try {
            setForegroundAsync(getForegroundInfo()).get()
        } catch (e: Exception) {
            // Android 12 and later refuse a foreground service started from the background (a run after the process was
            // killed): the job runs on as ordinary work, within the system's time limit, and continues next run.
            PageDownloads.log("Running without the notification: ${e.javaClass.simpleName}")
        }
        while (!isStopped) {
            val entry = PageDownloads.next(ctx) ?: return Result.success()
            val dest = Paths.under(DeviceStore.downloadsRoot(ctx), entry.path)
            if (dest == null) { PageDownloads.finish(ctx, entry.path, null, TransferFailure("io", 0, "Not a path in the downloads folder")); continue }
            if (dest.isFile && !java.io.File(dest.path + ".part").exists()) {
                PageDownloads.finish(ctx, entry.path, dest.length(), null)
                continue
            }
            val transfer = Transfer(entry.url, dest, entry.maxBytes, onProgress = { bytes, total ->
                PageDownloads.progress(entry.path, bytes, total)
                val now = System.currentTimeMillis()
                if (now - shown >= 1000) { shown = now; PageDownloads.showProgress(ctx, bytes, total) }
            })
            if (!PageDownloads.claim(ctx, entry.path, transfer)) continue
            current = transfer
            try {
                val bytes = transfer.run()
                PageDownloads.finish(ctx, entry.path, bytes, null)
            } catch (e: TransferFailure) {
                when {
                    // Stopped by the system: the entry stays and the next run continues it.
                    e.code == "cancelled" && isStopped -> break
                    // Stopped by hand: cancel() already told the page and forgot the entry (a new request for the path is another entry).
                    e.code == "cancelled" -> {}
                    // A lost connection while nobody watches: try again later, from where it stopped.
                    e.code == "network" && !DeviceStore.appVisible -> {
                        PageDownloads.endDrain()
                        if (runAttemptCount + 1 >= PageDownloads.MAX_ATTEMPTS) { PageDownloads.giveUp(ctx); return Result.success() }
                        PageDownloads.log("Connection lost; trying again later")
                        return Result.retry()
                    }
                    else -> PageDownloads.finish(ctx, entry.path, null, e)
                }
            } finally {
                current = null
                PageDownloads.release()
            }
        }
        PageDownloads.endDrain()
        return Result.retry()
    }
}
