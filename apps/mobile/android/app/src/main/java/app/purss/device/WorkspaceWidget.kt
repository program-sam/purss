package app.purss.device

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
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
 * The home-screen widget (plan/38): the next To read items and the current or last played episode,
 * drawn from the snapshot the page writes (and the background job refreshes). It holds titles and ids,
 * never the token. Tapping an item opens `purss://open?item=…` in the app, which only navigates.
 */
class WorkspaceWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, render(context))
    }

    companion object {
        private val ROWS = listOf(
            Triple(R.id.widget_row_0, R.id.widget_title_0, R.id.widget_source_0),
            Triple(R.id.widget_row_1, R.id.widget_title_1, R.id.widget_source_1),
            Triple(R.id.widget_row_2, R.id.widget_title_2, R.id.widget_source_2),
            Triple(R.id.widget_row_3, R.id.widget_title_3, R.id.widget_source_3),
        )

        private class Palette(val bg: Int, val ink: Int, val ink2: Int, val accent: Int, val line: Int)
        private val LIGHT = Palette(R.drawable.widget_bg_light, 0xff131e2a.toInt(), 0xff566371.toInt(), 0xff1260ba.toInt(), 0xffdce3ea.toInt())
        private val DARK = Palette(R.drawable.widget_bg_dark, 0xffeceff4.toInt(), 0xff9da5af.toInt(), 0xff98c6fb.toInt(), 0xff2f353c.toInt())
        private val EINK = Palette(R.drawable.widget_bg_eink, 0xff000000.toInt(), 0xff000000.toInt(), 0xff000000.toInt(), 0xff000000.toInt())

        fun redrawAll(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = manager.getAppWidgetIds(ComponentName(ctx, WorkspaceWidget::class.java))
            if (ids.isEmpty()) return
            val views = render(ctx)
            for (id in ids) manager.updateAppWidget(id, views)
        }

        /** Open the app at an item; the deep link only navigates. Explicit, so no other app receives it. */
        private fun openItem(ctx: Context, itemId: String): PendingIntent {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("purss://open?item=${Uri.encode(itemId)}"), ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(ctx, itemId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        private fun openApp(ctx: Context): PendingIntent {
            val intent = Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(ctx, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
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

        fun render(ctx: Context): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_workspace)
            val snapshot = try { DeviceStore.widget(ctx)?.let { JSONObject(it) } } catch (e: Exception) { null }
            v.setOnClickPendingIntent(R.id.widget_root, openApp(ctx))
            v.setOnClickPendingIntent(R.id.widget_header, openApp(ctx))
            val palette = when (snapshot?.optString("appearance")) {
                "light" -> LIGHT
                "dark" -> DARK
                "eink" -> EINK
                else -> null // the system's light or dark, through the resources
            }
            palette?.let { p ->
                v.setInt(R.id.widget_root, "setBackgroundResource", p.bg)
                v.setTextColor(R.id.widget_heading, p.accent)
                v.setTextColor(R.id.widget_count, p.ink2)
                v.setTextColor(R.id.widget_message, p.ink2)
                for ((_, title, source) in ROWS) { v.setTextColor(title, p.ink); v.setTextColor(source, p.ink2) }
                v.setInt(R.id.widget_line, "setBackgroundColor", p.line)
                v.setTextColor(R.id.widget_episode_title, p.ink)
                v.setTextColor(R.id.widget_episode_status, p.ink2)
                v.setInt(R.id.widget_play, "setColorFilter", p.accent)
            }
            if (snapshot == null) {
                v.setTextViewText(R.id.widget_message, ctx.getString(R.string.widget_not_connected))
                v.setViewVisibility(R.id.widget_message, View.VISIBLE)
                v.setTextViewText(R.id.widget_count, "")
                for ((row, _, _) in ROWS) v.setViewVisibility(row, View.GONE)
                v.setViewVisibility(R.id.widget_line, View.GONE)
                v.setViewVisibility(R.id.widget_episode, View.GONE)
                return v
            }
            val items = snapshot.optJSONArray("toRead")
            val count = items?.length() ?: 0
            v.setTextViewText(R.id.widget_count, if (snapshot.isNull("toReadTotal")) "" else snapshot.optLong("toReadTotal").toString())
            v.setTextViewText(R.id.widget_message, ctx.getString(R.string.widget_nothing))
            v.setViewVisibility(R.id.widget_message, if (count == 0) View.VISIBLE else View.GONE)
            for ((i, ids) in ROWS.withIndex()) {
                val (row, title, source) = ids
                val it = if (i < count) items!!.optJSONObject(i) else null
                val itemId = it?.optString("id").orEmpty()
                if (it == null || !Paths.isId(itemId)) { v.setViewVisibility(row, View.GONE); continue }
                v.setViewVisibility(row, View.VISIBLE)
                v.setTextViewText(title, it.optString("title"))
                v.setTextViewText(source, it.optString("sourceTitle"))
                v.setContentDescription(row, ctx.getString(R.string.widget_row, it.optString("title"), it.optString("sourceTitle")))
                v.setOnClickPendingIntent(row, openItem(ctx, itemId))
            }
            val ep = snapshot.optJSONObject("episode")
            val epId = ep?.optString("id").orEmpty()
            if (ep == null || !Paths.isId(epId)) {
                v.setViewVisibility(R.id.widget_line, View.GONE)
                v.setViewVisibility(R.id.widget_episode, View.GONE)
                return v
            }
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
            return v
        }
    }
}

/** The widget's play/pause: a command to the app's Media3 session (the audio plugin's service), as the system's media controls send. */
class WidgetPlayback : BroadcastReceiver() {
    companion object {
        const val TOGGLE = "app.purss.widget.TOGGLE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TOGGLE) return
        if (!DeviceStore.pageAlive) {
            // The app stopped since the widget was drawn: draw it again, with the episode opening the app.
            WorkspaceWidget.redrawAll(context)
            return
        }
        // A receiver's own context may not bind to services; the application's may.
        val app = context.applicationContext
        val pending = goAsync()
        val future = try {
            MediaController.Builder(app, SessionToken(app, ComponentName(app, AudioPlayerService::class.java))).buildAsync()
        } catch (e: Exception) {
            pending.finish()
            WorkspaceWidget.redrawAll(app)
            return
        }
        future.addListener({
            try {
                val controller = future.get()
                if (controller.isPlaying) controller.pause() else controller.play()
                controller.release()
            } catch (e: Exception) {
                WorkspaceWidget.redrawAll(app)
            } finally {
                pending.finish()
            }
        }, ContextCompat.getMainExecutor(app))
    }
}
