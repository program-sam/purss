package app.purss.device

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Who may write the panels' data, and when (plan/38). Every write of the lists, the choices and the page's
 * snapshot happens under `lock`; a disconnect or a refused token bumps `generation` under it, so a refresh
 * or setup that started before can't write the old account's titles back afterwards, and a refusal that
 * arrives late can't wipe a newer connection.
 */
object WidgetData {
    val lock = Any()
    @Volatile var generation = 0L
        private set

    /** Nothing that started before this may write any more. */
    fun invalidate() = synchronized(lock) { generation++ }

    /** Everything of the account the panels kept: their lists, which collection or source each shows, the page's snapshot. */
    fun wipe(ctx: Context) {
        synchronized(lock) {
            invalidate()
            DeviceStore.setLists(ctx, null)
            DeviceStore.setChoices(ctx, null)
            DeviceStore.setWidget(ctx, null)
        }
    }

    /** Run `write` only while nothing was wiped since `since` was read. */
    inline fun <T> ifCurrent(since: Long, write: () -> T): T? = synchronized(lock) { if (generation == since) write() else null }

    /**
     * The PURSS refused the token (401 `device_signed_out`) to a request made at `since`: nothing of the account stays
     * with the native side, and the page runs its own *lost* path when it next starts. Ignored when a disconnect came
     * in between (the refusal was the old connection's).
     */
    fun lost(ctx: Context, since: Long) {
        synchronized(lock) {
            if (generation != since) return
            BackgroundDownloads.forget(ctx, downloadsToo = true)
            // The notification fetcher's credential belongs to the same refused connection (plan/37).
            app.purss.PushTarget.clear(ctx)
            DeviceStore.markLost(ctx)
        }
    }
}

/**
 * The panels' lists, fetched by the native side (plan/38): every 15 minutes while any panel is placed (the
 * system decides when, within its battery rules), and soon after the app asks (its items changed, a panel was
 * placed or set up). One refresh at a time; asking during one runs one more pass after it.
 */
object WidgetRefresh {
    private const val TAG = "PurssWidgets"
    private const val PERIODIC = "purss-widget-refresh"
    private const val NOW = "purss-widget-refresh-now"

    private val running = Any()
    /** Guards `busy` and `again`, so a request made as a run finishes is never lost. */
    private val demand = Any()
    private var busy = false
    private var again = false

    private val connected = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /**
     * Every 15 minutes (Android's shortest), kept as it is when already scheduled. Nothing while no panel is placed, nor
     * after the token was refused until the page has taken that report (a new periodic job runs at once and would only
     * be refused again).
     */
    fun schedule(ctx: Context) {
        if (DeviceStore.isLost(ctx) || Panels.placed(ctx).isEmpty()) return
        val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(15, TimeUnit.MINUTES).setConstraints(connected).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** A refresh soon: once connected, after the one running now if there is one. */
    fun soon(ctx: Context) {
        if (DeviceStore.isLost(ctx) || Panels.placed(ctx).isEmpty()) return
        schedule(ctx)
        synchronized(demand) { if (busy) { again = true; return } }
        val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>().setConstraints(connected).build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, request)
    }

    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(ctx).cancelUniqueWork(NOW)
    }

    fun run(ctx: Context, stopped: () -> Boolean) {
        synchronized(running) {
            synchronized(demand) { busy = true; again = false }
            try {
                while (true) {
                    once(ctx, stopped)
                    synchronized(demand) {
                        if (!again || stopped()) { busy = false; return }
                        again = false
                    }
                }
            } finally {
                synchronized(demand) { busy = false }
            }
        }
    }

    private fun once(ctx: Context, stopped: () -> Boolean) {
        val since = WidgetData.generation
        if (DeviceStore.isLost(ctx)) return
        val conn = StoredConnection.read(ctx) ?: run { Log.i(TAG, "Not connected"); return }
        val placed = Panels.placed(ctx)
        val choices = WidgetLists.decodeChoices(DeviceStore.choices(ctx))
        val wanted = placed.mapNotNull { (id, kind) -> if (WidgetLists.isKey(kind)) kind else choices[id] }.distinct()
        if (wanted.isEmpty()) return
        val api = WorkspaceApi(conn)
        val old = WidgetLists.decode(DeviceStore.lists(ctx))
        try {
            // Names, and whether a chosen collection or source is still there (a removed source stays readable by id).
            val catalog = if (wanted.any { WidgetLists.configurable(it) }) {
                val a = api.get("/api/bootstrap")
                if (a.status == 200) WidgetLists.parseCatalog(a.text) else null
            } else null
            val out = mutableMapOf<String, WidgetLists.Stored>()
            for (key in wanted) {
                if (stopped()) return
                val chosen = WidgetLists.configurable(key)
                val name = if (chosen) catalog?.name(key) ?: old[key]?.name else null
                if (chosen) {
                    if (catalog == null) { old[key]?.let { out[key] = it }; continue }
                    val state = WidgetLists.chosenState(key, catalog)
                    // A private source's name never shows on a home screen either.
                    if (state != "ok") { out[key] = WidgetLists.Stored(emptyList(), null, state, if (state == "private") null else name); continue }
                }
                val a = api.get(WidgetLists.path(key) ?: continue)
                when {
                    a.status == 200 -> WidgetLists.parsePage(a.text).let { (rows, total) -> out[key] = WidgetLists.Stored(rows, total, "ok", name) }
                    a.status == 404 && chosen -> out[key] = WidgetLists.Stored(emptyList(), null, "gone", name)
                    // Busy or failing: the last list stays.
                    else -> old[key]?.let { out[key] = it }
                }
            }
            if (stopped()) return
            WidgetData.ifCurrent(since) { DeviceStore.setLists(ctx, WidgetLists.encode(out)) } ?: return
            Panels.redrawAll(ctx)
        } catch (e: Refused) {
            Log.i(TAG, "The workspace refused the token; removing what the app kept")
            WidgetData.lost(ctx, since)
        } catch (e: Exception) {
            // Offline or the PURSS is busy: the last lists stay, and the next run tries again.
            Log.i(TAG, "Panels not refreshed: ${e.javaClass.simpleName}")
        }
    }
}

class WidgetRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        WidgetRefresh.run(applicationContext) { isStopped }
        return Result.success()
    }
}
