package app.purss.device

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import org.json.JSONObject
import app.purss.MainActivity
import app.purss.R
import us.mediagrid.capacitorjs.plugins.nativeaudio.AudioPlayerService

/**
 * The home-screen panels (plan/38). Each kind is its own provider, so the launcher offers them separately:
 * To read (the class keeps its first name, so panels placed before stay), To listen (with the current or last
 * played episode and its play/pause), New, a chosen collection and a chosen source. They draw the lists
 * WidgetRefresh keeps and the page's look and episode; they hold titles and ids, never the token. Taps open
 * `purss://open?…` in the app, which only navigates.
 */
abstract class PanelWidget(private val kind: String) : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, Panels.render(context, kind, id, manager.getAppWidgetOptions(id)))
        WidgetRefresh.schedule(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        manager.updateAppWidget(id, Panels.render(context, kind, id, options))
    }

    override fun onEnabled(context: Context) {
        WidgetRefresh.soon(context)
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        synchronized(WidgetData.lock) {
            val choices = WidgetLists.decodeChoices(DeviceStore.choices(context))
            if (ids.any { it in choices }) DeviceStore.setChoices(context, WidgetLists.encodeChoices(choices - ids.toSet()))
        }
    }

    override fun onDisabled(context: Context) {
        if (Panels.placed(context).isEmpty()) WidgetRefresh.cancel(context)
    }
}

class WorkspaceWidget : PanelWidget("toread")
class ToListenWidget : PanelWidget("tolisten")
class NewWidget : PanelWidget("new")
class CollectionWidget : PanelWidget("collection")
class SourceWidget : PanelWidget("source")

object Panels {
    private val KINDS = listOf(
        WorkspaceWidget::class.java to "toread",
        ToListenWidget::class.java to "tolisten",
        NewWidget::class.java to "new",
        CollectionWidget::class.java to "collection",
        SourceWidget::class.java to "source",
    )

    private val ROWS = listOf(
        Triple(R.id.widget_row_0, R.id.widget_title_0, R.id.widget_source_0),
        Triple(R.id.widget_row_1, R.id.widget_title_1, R.id.widget_source_1),
        Triple(R.id.widget_row_2, R.id.widget_title_2, R.id.widget_source_2),
        Triple(R.id.widget_row_3, R.id.widget_title_3, R.id.widget_source_3),
        Triple(R.id.widget_row_4, R.id.widget_title_4, R.id.widget_source_4),
        Triple(R.id.widget_row_5, R.id.widget_title_5, R.id.widget_source_5),
        Triple(R.id.widget_row_6, R.id.widget_title_6, R.id.widget_source_6),
        Triple(R.id.widget_row_7, R.id.widget_title_7, R.id.widget_source_7),
    )

    private val AVATARS = listOf(R.id.widget_avatar_0, R.id.widget_avatar_1, R.id.widget_avatar_2, R.id.widget_avatar_3,
        R.id.widget_avatar_4, R.id.widget_avatar_5, R.id.widget_avatar_6, R.id.widget_avatar_7)

    /** A look the app's theme picks; "system" draws through the night-qualified resources instead (see paint). */
    private class Look(
        val bg: Int, val band: Int, val avatar: Int,
        val ink: Int, val ink2: Int, val accent: Int, val line: Int, val bandLine: Int,
        val night: Boolean, val eink: Boolean = false,
    )
    private val LIGHT = Look(R.drawable.widget_bg_light, R.drawable.widget_header_band_light, R.drawable.widget_avatar_light,
        0xff131e2a.toInt(), 0xff566371.toInt(), 0xff1260ba.toInt(), 0xffdce3ea.toInt(), 0xffd3dfee.toInt(), night = false)
    private val DARK = Look(R.drawable.widget_bg_dark, R.drawable.widget_header_band_dark, R.drawable.widget_avatar_dark,
        0xffeceff4.toInt(), 0xff9da5af.toInt(), 0xff98c6fb.toInt(), 0xff2f353c.toInt(), 0xff354150.toInt(), night = true)
    private val EINK = Look(R.drawable.widget_bg_eink, R.drawable.widget_header_band_eink, R.drawable.widget_avatar_eink,
        0xff000000.toInt(), 0xff000000.toInt(), 0xff000000.toInt(), 0xff000000.toInt(), 0xff000000.toInt(), night = false, eink = true)

    private val INKED = listOf(R.id.widget_episode_title) + ROWS.map { it.second }
    private val INKED_2 = listOf(R.id.widget_count, R.id.widget_message, R.id.widget_episode_status) + ROWS.map { it.third }

    /**
     * Every colour and background, on every draw: a launcher may apply an update onto the views it already shows, so
     * anything left unset keeps what the last draw gave it. "system" uses resources the launcher resolves, so the panel
     * follows the system's light and dark (Android 12 and later; before that, as the system was when drawn).
     */
    private fun paint(ctx: Context, v: RemoteViews, look: Look?) {
        val sys = look == null
        val l = look ?: if (night(ctx)) DARK else LIGHT
        v.setInt(R.id.widget_root, "setBackgroundResource", if (sys) R.drawable.widget_bg else l.bg)
        v.setInt(R.id.widget_header, "setBackgroundResource", if (sys) R.drawable.widget_header_band else l.band)
        for (av in AVATARS) v.setInt(av, "setBackgroundResource", if (sys) R.drawable.widget_avatar else l.avatar)
        if (sys && android.os.Build.VERSION.SDK_INT >= 31) {
            v.setColor(R.id.widget_heading, "setTextColor", R.color.widget_accent)
            for (id in INKED) v.setColor(id, "setTextColor", R.color.widget_ink)
            for (id in INKED_2) v.setColor(id, "setTextColor", R.color.widget_ink_2)
            v.setColor(R.id.widget_line, "setBackgroundColor", R.color.widget_line)
            v.setColor(R.id.widget_header_line, "setBackgroundColor", R.color.widget_band_line)
            v.setColor(R.id.widget_play, "setColorFilter", R.color.widget_accent)
            return
        }
        v.setTextColor(R.id.widget_heading, l.accent)
        for (id in INKED) v.setTextColor(id, l.ink)
        for (id in INKED_2) v.setTextColor(id, l.ink2)
        v.setInt(R.id.widget_line, "setBackgroundColor", l.line)
        v.setInt(R.id.widget_header_line, "setBackgroundColor", l.bandLine)
        v.setInt(R.id.widget_play, "setColorFilter", l.accent)
    }

    /** A row's source tile: its initials, tinted by the source's hue as in the app (Android 12 and later; a plain tile before). */
    private fun avatar(ctx: Context, v: RemoteViews, id: Int, source: String, look: Look?) {
        val name = source.ifEmpty { "Saved link" }
        v.setTextViewText(id, WidgetLists.initials(name))
        val l = look ?: if (night(ctx)) DARK else LIGHT
        if (android.os.Build.VERSION.SDK_INT < 31) { v.setTextColor(id, if (l.eink) 0xff000000.toInt() else WidgetLists.avatarInk(WidgetLists.hue(name), l.night)); return }
        if (l.eink) {
            v.setColorStateList(id, "setBackgroundTintList", null)
            v.setTextColor(id, 0xff000000.toInt())
            return
        }
        val h = WidgetLists.hue(name)
        if (look == null) {
            v.setColorStateList(id, "setBackgroundTintList", ColorStateList.valueOf(WidgetLists.avatarTile(h, false)), ColorStateList.valueOf(WidgetLists.avatarTile(h, true)))
            v.setColorInt(id, "setTextColor", WidgetLists.avatarInk(h, false), WidgetLists.avatarInk(h, true))
        } else {
            v.setColorStateList(id, "setBackgroundTintList", ColorStateList.valueOf(WidgetLists.avatarTile(h, l.night)))
            v.setTextColor(id, WidgetLists.avatarInk(h, l.night))
        }
    }

    private fun night(ctx: Context) =
        (ctx.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    /** Every placed panel: its id and kind (`toread`, `tolisten`, `new`, `collection`, `source`). */
    fun placed(ctx: Context): List<Pair<Int, String>> {
        val manager = AppWidgetManager.getInstance(ctx)
        return KINDS.flatMap { (cls, kind) -> manager.getAppWidgetIds(ComponentName(ctx, cls)).map { it to kind } }
    }

    /** The kind of a placed panel, or null when the id isn't one of this app's. */
    fun kindOf(ctx: Context, id: Int): String? {
        val provider = AppWidgetManager.getInstance(ctx).getAppWidgetInfo(id)?.provider ?: return null
        return KINDS.firstOrNull { (cls, _) -> provider.className == cls.name && provider.packageName == ctx.packageName }?.second
    }

    fun redrawAll(ctx: Context) {
        val manager = AppWidgetManager.getInstance(ctx)
        for ((id, kind) in placed(ctx)) manager.updateAppWidget(id, render(ctx, kind, id, manager.getAppWidgetOptions(id)))
    }

    fun redraw(ctx: Context, id: Int) {
        val kind = kindOf(ctx, id) ?: return
        val manager = AppWidgetManager.getInstance(ctx)
        manager.updateAppWidget(id, render(ctx, kind, id, manager.getAppWidgetOptions(id)))
    }

    /** Open the app at an item; the deep link only navigates. Explicit, so no other app receives it. */
    private fun openItem(ctx: Context, itemId: String) = openLink(ctx, "item=${Uri.encode(itemId)}")

    /** Open the app at the list a panel shows. */
    private fun openList(ctx: Context, key: String) = openLink(ctx, "list=${Uri.encode(key)}")

    private fun openLink(ctx: Context, query: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("purss://open?$query"), ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(ctx, query.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun openApp(ctx: Context): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(ctx, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Choose (again) what a collection or source panel shows. */
    private fun setup(ctx: Context, id: Int): PendingIntent {
        val intent = Intent(ctx, WidgetSetupActivity::class.java)
            .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
            .setData(Uri.parse("purss-widget://setup/$id")) // one PendingIntent per panel
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(ctx, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun toggle(ctx: Context): PendingIntent {
        val intent = Intent(ctx, WidgetPlayback::class.java).setAction(WidgetPlayback.TOGGLE)
        return PendingIntent.getBroadcast(ctx, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun clock(seconds: Long): String {
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        val s = seconds % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, s) else String.format("%d:%02d", m, s)
    }

    private fun heading(ctx: Context, kind: String): String = ctx.getString(when (kind) {
        "toread" -> R.string.widget_to_read
        "tolisten" -> R.string.widget_to_listen
        "new" -> R.string.widget_new
        "collection" -> R.string.widget_collection
        else -> R.string.widget_source
    })

    private fun empty(ctx: Context, kind: String): String = ctx.getString(when (kind) {
        "toread" -> R.string.widget_nothing
        "tolisten" -> R.string.widget_nothing_to_listen
        "new" -> R.string.widget_nothing_new
        else -> R.string.widget_nothing_here
    })

    private fun age(at: String?, now: Long): String {
        val t = at?.let { WidgetLists.millis(it) } ?: return ""
        return DateUtils.getRelativeTimeSpanString(t, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString()
    }

    fun render(ctx: Context, kind: String, id: Int, options: Bundle?): RemoteViews {
        val v = RemoteViews(ctx.packageName, R.layout.widget_panel)
        val snapshot = try { DeviceStore.widget(ctx)?.let { JSONObject(it) } } catch (e: Exception) { null }
        val look = when (snapshot?.optString("appearance")) {
            "light" -> LIGHT
            "dark" -> DARK
            "eink" -> EINK
            else -> null // the system's light or dark, through the resources
        }
        paint(ctx, v, look)
        v.setOnClickPendingIntent(R.id.widget_root, openApp(ctx))
        v.setOnClickPendingIntent(R.id.widget_header, openApp(ctx))
        v.setTextViewText(R.id.widget_heading, heading(ctx, kind))
        v.setTextViewText(R.id.widget_count, "")
        v.setViewVisibility(R.id.widget_line, View.GONE)
        v.setViewVisibility(R.id.widget_episode, View.GONE)
        for ((row, _, _) in ROWS) v.setViewVisibility(row, View.GONE)
        val message = { text: String ->
            v.setTextViewText(R.id.widget_message, text)
            v.setViewVisibility(R.id.widget_message, View.VISIBLE)
        }
        // No snapshot from the page: the app isn't connected (or was disconnected).
        if (snapshot == null) { message(ctx.getString(R.string.widget_not_connected)); return v }

        val chosen = kind == "collection" || kind == "source"
        val key = if (chosen) WidgetLists.decodeChoices(DeviceStore.choices(ctx))[id] else kind
        if (key == null) {
            message(ctx.getString(if (kind == "collection") R.string.widget_choose_collection else R.string.widget_choose_source))
            v.setOnClickPendingIntent(R.id.widget_root, setup(ctx, id))
            v.setOnClickPendingIntent(R.id.widget_header, setup(ctx, id))
            return v
        }
        val stored = WidgetLists.decode(DeviceStore.lists(ctx))[key]
        stored?.name?.let { v.setTextViewText(R.id.widget_heading, it) }
        v.setOnClickPendingIntent(R.id.widget_header, openList(ctx, key))

        val episode = if (kind == "tolisten") drawEpisode(ctx, v, snapshot) else false
        when {
            stored == null -> { message(ctx.getString(R.string.widget_loading)); return v }
            stored.state == "gone" || stored.state == "private" -> {
                message(ctx.getString(when {
                    stored.state == "private" -> R.string.widget_private_source
                    kind == "collection" -> R.string.widget_collection_gone
                    else -> R.string.widget_source_gone
                }))
                v.setOnClickPendingIntent(R.id.widget_root, setup(ctx, id))
                v.setOnClickPendingIntent(R.id.widget_header, setup(ctx, id))
                return v
            }
        }
        val list = stored!!
        list.total?.let { v.setTextViewText(R.id.widget_count, it.toString()) }
        v.setTextViewText(R.id.widget_message, if (list.state == "loading") ctx.getString(R.string.widget_loading) else empty(ctx, kind))
        v.setViewVisibility(R.id.widget_message, if (list.rows.isEmpty()) View.VISIBLE else View.GONE)
        // The launcher reports the panel's height in landscape as the smallest and in portrait as the largest.
        val portrait = ctx.resources.configuration.orientation != android.content.res.Configuration.ORIENTATION_LANDSCAPE
        val height = options?.getInt(if (portrait) AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT) ?: 0
        val shown = WidgetLists.rowsFor(height, episode)
        val now = System.currentTimeMillis()
        for ((i, ids) in ROWS.withIndex()) {
            val (row, title, source) = ids
            val r = list.rows.getOrNull(i)
            if (r == null || i >= shown) continue
            v.setViewVisibility(row, View.VISIBLE)
            v.setTextViewText(title, r.title)
            val meta = listOf(r.sourceTitle, age(r.at, now)).filter { it.isNotEmpty() }.joinToString(", ")
            v.setTextViewText(source, meta)
            avatar(ctx, v, AVATARS[i], r.sourceTitle, look)
            v.setContentDescription(row, ctx.getString(R.string.widget_row, r.title, meta))
            v.setOnClickPendingIntent(row, openItem(ctx, r.id))
        }
        return v
    }

    /** The current or last played episode above the To listen list; false when there is none. */
    private fun drawEpisode(ctx: Context, v: RemoteViews, snapshot: JSONObject): Boolean {
        val ep = snapshot.optJSONObject("episode") ?: return false
        val epId = ep.optString("id")
        if (!Paths.isId(epId)) return false
        val title = ep.optString("title")
        val playing = ep.optBoolean("playing") && DeviceStore.pageAlive
        val position = ep.optLong("positionSeconds")
        v.setViewVisibility(R.id.widget_line, View.VISIBLE)
        v.setViewVisibility(R.id.widget_episode, View.VISIBLE)
        v.setTextViewText(R.id.widget_episode_title, title)
        val status = when {
            playing -> ctx.getString(R.string.widget_playing)
            position > 0 -> ctx.getString(R.string.widget_paused_at, clock(position))
            else -> ctx.getString(R.string.widget_paused)
        }
        v.setTextViewText(R.id.widget_episode_status, listOf(ep.optString("sourceTitle"), status).filter { it.isNotEmpty() }.joinToString(" · "))
        v.setOnClickPendingIntent(R.id.widget_episode_text, openItem(ctx, epId))
        v.setImageViewResource(R.id.widget_play, if (playing) R.drawable.ic_widget_pause else R.drawable.ic_widget_play)
        // Play/pause goes to the app's running player; when the app isn't running (or has nothing loaded) it opens the episode.
        val live = DeviceStore.pageAlive && ep.optBoolean("loaded")
        v.setOnClickPendingIntent(R.id.widget_play, if (live) toggle(ctx) else openItem(ctx, epId))
        v.setContentDescription(R.id.widget_play, ctx.getString(if (!live) R.string.widget_open else if (playing) R.string.widget_pause else R.string.widget_play, title))
        return true
    }
}

/** The To listen panel's play/pause: a command to the app's Media3 session (the audio plugin's service), as the system's media controls send. */
class WidgetPlayback : BroadcastReceiver() {
    companion object {
        const val TOGGLE = "app.purss.widget.TOGGLE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TOGGLE) return
        if (!DeviceStore.pageAlive) {
            // The app stopped since the panel was drawn: draw it again, with the episode opening the app.
            Panels.redrawAll(context)
            return
        }
        // A receiver's own context may not bind to services; the application's may.
        val app = context.applicationContext
        val pending = goAsync()
        val future = try {
            MediaController.Builder(app, SessionToken(app, ComponentName(app, AudioPlayerService::class.java))).buildAsync()
        } catch (e: Exception) {
            pending.finish()
            Panels.redrawAll(app)
            return
        }
        future.addListener({
            try {
                val controller = future.get()
                if (controller.isPlaying) controller.pause() else controller.play()
                controller.release()
            } catch (e: Exception) {
                Panels.redrawAll(app)
            } finally {
                pending.finish()
            }
        }, ContextCompat.getMainExecutor(app))
    }
}
