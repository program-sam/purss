package app.purss.device

import android.content.Context
import android.content.SharedPreferences
import java.io.File

/**
 * What the native side keeps for the page (plan/38), in the app's private preferences: the background
 * job's state as the page mirrored it, the page's part of the home-screen panels (look and episode), the
 * panels' lists and which collection or source each configurable panel shows, and whether the token was
 * found refused. Never the token: that stays in the secure storage the page uses (StoredConnection).
 */
object DeviceStore {
    private const val PREFS = "purss.device"
    private const val BACKGROUND = "background"
    private const val WIDGET = "widget"
    private const val LOST = "lost"
    private const val LISTS = "widget-lists"
    private const val CHOICES = "widget-choices"

    /** The app's screen is showing: the open app downloads by itself, so the background job keeps out of its way. */
    @Volatile var appVisible = false

    /** The page in this process has written the widget's snapshot, so its player can take play/pause. */
    @Volatile var pageAlive = false

    private fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The downloads folder the page reads through @capacitor/filesystem (`downloads/` in Directory.LibraryNoCloud). */
    fun downloadsRoot(ctx: Context) = File(ctx.filesDir, "downloads")

    /** Where the background job assembles an item before moving it into the downloads folder. */
    fun incomingRoot(ctx: Context) = File(ctx.filesDir, "downloads-incoming")

    fun background(ctx: Context): String? = prefs(ctx).getString(BACKGROUND, null)
    fun setBackground(ctx: Context, state: String?) = prefs(ctx).edit().apply { if (state == null) remove(BACKGROUND) else putString(BACKGROUND, state) }.commit()

    fun widget(ctx: Context): String? = prefs(ctx).getString(WIDGET, null)
    fun setWidget(ctx: Context, snapshot: String?) = prefs(ctx).edit().apply { if (snapshot == null) remove(WIDGET) else putString(WIDGET, snapshot) }.commit()

    /** The panels' lists (WidgetLists.encode), written only by WidgetRefresh under `WidgetData.lock`. */
    fun lists(ctx: Context): String? = prefs(ctx).getString(LISTS, null)
    fun setLists(ctx: Context, json: String?) = prefs(ctx).edit().apply { if (json == null) remove(LISTS) else putString(LISTS, json) }.commit()

    /** Which list each placed configurable panel shows (WidgetLists.encodeChoices). Account data: wiped with it. */
    fun choices(ctx: Context): String? = prefs(ctx).getString(CHOICES, null)
    fun setChoices(ctx: Context, json: String?) = prefs(ctx).edit().apply { if (json == null) remove(CHOICES) else putString(CHOICES, json) }.commit()

    fun markLost(ctx: Context) = prefs(ctx).edit().putBoolean(LOST, true).commit()
    /** The token was found refused and the page hasn't taken the report yet. */
    fun isLost(ctx: Context): Boolean = prefs(ctx).getBoolean(LOST, false)

    fun takeLost(ctx: Context): Boolean {
        val lost = prefs(ctx).getBoolean(LOST, false)
        if (lost) prefs(ctx).edit().remove(LOST).commit()
        return lost
    }
}
