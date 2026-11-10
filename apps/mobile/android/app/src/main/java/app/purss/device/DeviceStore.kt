package app.purss.device

import android.content.Context
import android.content.SharedPreferences
import java.io.File

/**
 * What the native side keeps for the page (plan/38), in the app's private preferences: the background
 * job's state as the page mirrored it, the widget's snapshot, and whether the job found the token
 * refused. Never the token: that stays in the secure storage the page uses (StoredConnection).
 */
object DeviceStore {
    private const val PREFS = "purss.device"
    private const val BACKGROUND = "background"
    private const val WIDGET = "widget"
    private const val LOST = "lost"

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

    fun markLost(ctx: Context) = prefs(ctx).edit().putBoolean(LOST, true).commit()
    fun takeLost(ctx: Context): Boolean {
        val lost = prefs(ctx).getBoolean(LOST, false)
        if (lost) prefs(ctx).edit().remove(LOST).commit()
        return lost
    }
}
