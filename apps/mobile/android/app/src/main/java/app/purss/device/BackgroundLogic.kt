package app.purss.device

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * The background job's reading and writing of the page's formats (plan/38), apart from Android, so it
 * is unit-tested on the JVM. The formats are defined by the page: BackgroundState and record.json in
 * apps/web/src/downloads/background.ts, and the plan in packages/domain/src/downloads.ts. Which items to download is the PURSS's answer to
 * the plan request; nothing here decides that.
 */
object BackgroundLogic {
    /** The largest file the apps download (MAX_DOWNLOAD_BYTES). */
    const val MAX_DOWNLOAD_BYTES = 4L * 1024 * 1024 * 1024
    data class State(
        val accountId: String,
        val origin: String,
        val autoToRead: Boolean,
        val wifiOnly: Boolean,
        val limitBytes: Long,
        val have: List<String>,
        val usedBytes: Long,
    ) {
        val wantsDownloads get() = autoToRead
        /** Room left under the limit for the next automatic download, and never more than the largest download. */
        val room get() = minOf(MAX_DOWNLOAD_BYTES, maxOf(0L, limitBytes - usedBytes))
    }

    fun parseState(json: String?): State? = try {
        val o = JSONObject(json ?: "")
        val s = o.getJSONObject("settings")
        val have = o.getJSONArray("have")
        val accountId = o.getString("accountId")
        if (!Paths.isId(accountId)) null else State(
            accountId = accountId,
            origin = o.getString("origin"),
            autoToRead = s.optBoolean("autoToRead", false),
            wifiOnly = s.optBoolean("wifiOnly", true),
            limitBytes = s.optLong("limitBytes", 0L),
            have = (0 until have.length()).map { have.getString(it) },
            usedBytes = o.optLong("usedBytes", 0L),
        )
    } catch (e: Exception) {
        null
    }

    /** Only a publisher's https file is ever fetched; plain http is refused whatever the caller asks. */
    fun downloadAllowed(url: String): Boolean = url.startsWith("https://", ignoreCase = true)

    /** The most a download may take: what the caller asks, never more than MAX_DOWNLOAD_BYTES. */
    fun downloadCap(maxBytes: Long?): Long = if (maxBytes == null || maxBytes <= 0) MAX_DOWNLOAD_BYTES else minOf(maxBytes, MAX_DOWNLOAD_BYTES)

    /** Whether a finished item may move into the downloads folder: the job runs on and the mirrored state is still this account's. */
    fun mayKeep(stateJson: String?, accountId: String, stopped: Boolean): Boolean =
        !stopped && parseState(stateJson)?.accountId == accountId

    /** The state after an item's record was written: it is had now, and a finished download counts toward the total. */
    fun afterDownload(json: String, itemId: String, bytes: Long): String {
        val o = JSONObject(json)
        o.getJSONArray("have").put(itemId)
        o.put("usedBytes", o.optLong("usedBytes", 0L) + bytes)
        return o.toString()
    }

    fun planRequest(s: State): String = JSONObject()
        .put("autoToRead", s.autoToRead)
        .put("limitBytes", s.limitBytes)
        .put("usedBytes", s.usedBytes)
        .put("have", JSONArray(s.have))
        .toString()

    data class PlanItem(val id: String, val url: String, val type: String?, val kind: String, val declaredBytes: Long?, val file: String)

    /** The PURSS's plan; items with an id or file name that couldn't be a plain path, or without an address, are left out. */
    fun parsePlan(text: String): List<PlanItem> {
        val items = JSONObject(text).getJSONArray("items")
        return (0 until items.length()).mapNotNull { i ->
            val it = items.getJSONObject(i)
            val m = it.getJSONObject("media")
            val id = it.getString("id")
            val file = m.getString("file")
            val url = m.str("url")
            if (!Paths.isId(id) || url == null || !Regex("^media(\\.[a-z0-9]{2,4})?$").matches(file)) null
            else PlanItem(id, url, m.str("type"), m.getString("kind"), if (m.isNull("declaredBytes")) null else m.getLong("declaredBytes"), file)
        }
    }

    /** What record.json needs from the item's details (the answer of GET /api/items/:id). */
    data class Detail(val title: String, val sourceTitle: String, val kind: String, val annotated: Boolean)

    fun parseDetail(text: String): Detail {
        val o = JSONObject(text)
        return Detail(o.optString("title"), o.optString("sourceTitle"), o.optString("kind", "article"), !o.isNull("annotatedAt"))
    }

    fun doneRecord(accountId: String, itemId: String, d: Detail, p: PlanItem, mediaBytes: Long, textBytes: Long, now: Date): String = JSONObject()
        .put("itemId", itemId).put("title", d.title).put("sourceTitle", d.sourceTitle).put("kind", d.kind)
        .put("state", "done").put("status", JSONObject.NULL)
        .put("media", JSONObject().put("file", "$accountId/$itemId/${p.file}").put("bytes", mediaBytes).put("type", p.type ?: JSONObject.NULL).put("kind", p.kind))
        .put("textBytes", textBytes).put("savedAt", iso(now))
        .toString()

    /** `status`: the server's answer, 0 for a lost connection, -1 for a publisher's file over plain http, -2 for too large. */
    fun failedRecord(itemId: String, d: Detail, status: Int, now: Date): String = JSONObject()
        .put("itemId", itemId).put("title", d.title).put("sourceTitle", d.sourceTitle).put("kind", d.kind)
        .put("state", "failed").put("status", status).put("media", JSONObject.NULL)
        .put("textBytes", 0).put("savedAt", iso(now))
        .toString()

    /**
     * Whether a 401 answer says the credential is gone for good: its error code must be `code`
     * (`device_signed_out` for the device token, `push_signed_out` for the notification credential), as the
     * page's transport requires. Any other 401 (a proxy, a captive portal, a server mid-restart) is transient.
     */
    @JvmStatic
    fun refusedWith(body: String?, code: String): Boolean = try {
        JSONObject(body ?: "").getJSONObject("error").optString("code") == code
    } catch (e: Exception) {
        false
    }

    fun iso(d: Date): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(d)

    private fun JSONObject.str(k: String): String? = if (isNull(k)) null else getString(k)
}
