package app.purss.device

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log

/**
 * The new items on the app's icon. Android has no badge of its own: launchers draw a dot while the app has
 * notifications, and those that show a number add up each notification's number (at least one each). So the count
 * goes on PURSS's notifications in the shade: the newest carries what the others don't. Without a notification there
 * is no badge, and with more notifications than new items the launcher counts the notifications.
 */
object Badge {
    /** The channel of PURSS's notifications (PushFetcher's, in the full build). */
    const val CHANNEL = "purss"
    private const val TAG = "PurssBadge"

    /**
     * The number for each of `notifications` notifications, oldest first, so that they add up to `count`: the newest
     * carries the rest, the others one each. Zero (no number) for all when the notifications already reach the count.
     */
    fun numbers(count: Int, notifications: Int): List<Int> {
        if (notifications <= 0) return emptyList()
        if (count <= notifications) return List(notifications) { 0 }
        return List(notifications - 1) { 1 } + (count - (notifications - 1))
    }

    /** Puts `count` on the notifications shown now, changing only those whose number differs, without alerting again. */
    @JvmStatic
    fun apply(ctx: Context, count: Int) {
        numberFor(ctx, count, emptyList())
    }

    /**
     * Before notifications tagged `posting` (oldest first) are posted or replaced: numbers the others shown now and
     * returns the numbers for those, so they go out with them rather than being rebuilt from a list the system may not
     * have caught up with yet.
     */
    @JvmStatic
    fun numberFor(ctx: Context, count: Int, posting: List<String>): List<Int> {
        // Dots and launcher numbers came with notification channels (Android 8).
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return List(posting.size) { 0 }
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return List(posting.size) { 0 }
        return try {
            // Group summaries (Android bundles four or more by itself) aren't counted by launchers.
            val others = nm.activeNotifications.filter {
                it.notification.channelId == CHANNEL && it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 && it.tag !in posting
            }.sortedBy { it.notification.`when` }
            val all = numbers(count.coerceAtLeast(0), others.size + posting.size)
            others.forEachIndexed { i, s ->
                if (s.notification.number == all[i]) return@forEachIndexed
                val again = Notification.Builder.recoverBuilder(ctx, s.notification).setNumber(all[i]).setOnlyAlertOnce(true)
                nm.notify(s.tag, s.id, again.build())
            }
            all.drop(others.size)
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't update the count on the notifications: " + e.javaClass.simpleName)
            List(posting.size) { 0 }
        }
    }
}
