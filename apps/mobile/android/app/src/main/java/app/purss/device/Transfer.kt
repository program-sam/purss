package app.purss.device

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Why a transfer ended without a file: `http` (with the server's status), `network`, `too_large`,
 * `cancelled`, `io` (the file couldn't be written). The same codes the page's plugin interface names.
 */
class TransferFailure(val code: String, val status: Int = 0, message: String) : Exception(message)

/**
 * One file fetched over HTTP(S) into `dest`, written as `dest.part` and renamed when complete, so a
 * half-written file never has the real name. Blocking: run it off the main thread.
 *
 * A transfer cut off by the connection, by `shouldStop`, or by `cancel(discard = false)` keeps its
 * `.part` and, beside it, `.part.json` with the address and the server's validator (a strong ETag or
 * Last-Modified). The next transfer of the same address into the same file asks only for the rest
 * (`Range` with `If-Range`), and starts again from nothing when the server sends the whole file. Any
 * other ending removes both.
 */
class Transfer(
    private val url: String,
    private val dest: File,
    private val maxBytes: Long?,
    private val onProgress: (bytes: Long, total: Long) -> Unit = { _, _ -> },
    private val shouldStop: () -> Boolean = { false },
) {
    @Volatile private var cancelled = false
    @Volatile private var discard = false
    @Volatile private var connection: HttpURLConnection? = null

    private val part = File(dest.path + ".part")
    private val meta = File(dest.path + ".part.json")

    /** Closes the connection at once. `discard`: the partial file goes too (stopped by hand); otherwise it waits to be continued. */
    fun cancel(discard: Boolean = true) {
        if (discard) this.discard = true
        cancelled = true
        connection?.disconnect()
    }

    private fun stopped() = cancelled || shouldStop()

    fun run(): Long {
        val u = try { URL(url) } catch (e: Exception) { throw TransferFailure("network", 0, "Not a web address") }
        if (u.protocol != "https" && u.protocol != "http") throw TransferFailure("network", 0, "Not a web address")
        var keep = false
        try {
            dest.parentFile?.mkdirs()
            val bytes = fetch(u, resume = true)
            // Stopped by hand as it ended: the file doesn't take its real name.
            if (cancelled && discard) throw TransferFailure("cancelled", 0, "Stopped")
            if (dest.exists()) dest.delete()
            if (!part.renameTo(dest)) throw TransferFailure("io", 0, "Couldn't write the file")
            meta.delete()
            return bytes
        } catch (e: TransferFailure) {
            keep = e.code == "network" || (e.code == "cancelled" && !discard)
            throw e
        } catch (e: Exception) {
            val f = failure(e)
            keep = f.code == "network" || (f.code == "cancelled" && !discard)
            throw f
        } finally {
            connection?.disconnect()
            connection = null
            if (!keep || !part.exists() || !meta.exists()) { part.delete(); meta.delete() }
        }
    }

    /** `resume`: ask for the rest of a kept partial file. A server that can't give the rest is asked once more for everything. */
    private fun fetch(u: URL, resume: Boolean): Long {
        val validator = if (resume) TransferResume.validatorFor(meta, url, part) else null
        if (validator == null) { part.delete(); meta.delete() }
        val have = if (validator != null) part.length() else 0L
        val conn = u.openConnection() as HttpURLConnection
        connection = conn
        if (stopped()) throw TransferFailure("cancelled", 0, "Stopped")
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("Accept-Encoding", "identity")
        if (validator != null) {
            conn.setRequestProperty("Range", "bytes=$have-")
            conn.setRequestProperty("If-Range", validator)
        }
        val status = try { conn.responseCode } catch (e: IOException) { throw failure(e) }
        if (status == 416 && validator != null) {
            conn.disconnect()
            return fetch(u, resume = false)
        }
        if (status !in 200..299) throw TransferFailure("http", status, "HTTP $status")
        val appending = status == 206 && validator != null && TransferResume.rangeStart(conn.getHeaderField("Content-Range")) == have
        if (status == 206 && !appending) {
            // A part this transfer didn't ask for: start again from nothing.
            conn.disconnect()
            if (validator == null) throw TransferFailure("network", 0, "Unexpected partial answer")
            return fetch(u, resume = false)
        }
        val total = if (appending) TransferResume.rangeTotal(conn.getHeaderField("Content-Range")) ?: -1L else conn.contentLengthLong
        if (maxBytes != null && total > maxBytes) throw TransferFailure("too_large", 0, "Larger than allowed")
        if (!appending) {
            part.delete()
            meta.delete()
            TransferResume.validatorOf(conn.getHeaderField("ETag"), conn.getHeaderField("Last-Modified"))?.let {
                try { meta.writeText(JSONObject().put("url", url).put("validator", it).toString()) } catch (_: IOException) { /* not resumable, still fine */ }
            }
        }
        var bytes = if (appending) have else 0L
        var told = 0L
        try {
            conn.inputStream.use { input ->
                FileOutputStream(part, appending).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (stopped()) throw TransferFailure("cancelled", 0, "Stopped")
                        val n = input.read(buf)
                        if (n < 0) break
                        bytes += n
                        if (maxBytes != null && bytes > maxBytes) throw TransferFailure("too_large", 0, "Larger than allowed")
                        try { out.write(buf, 0, n) } catch (e: IOException) { throw TransferFailure("io", 0, "Couldn't write the file") }
                        val now = System.currentTimeMillis()
                        if (now - told >= 250) { told = now; onProgress(bytes, total) }
                    }
                }
            }
        } catch (e: TransferFailure) {
            throw e
        } catch (e: IOException) {
            throw failure(e)
        }
        if (total > 0 && bytes < total) throw TransferFailure("network", 0, "The connection ended early")
        onProgress(bytes, total)
        return bytes
    }

    /** The message names the kind of failure only: an exception's own message can carry the address. */
    private fun failure(e: Exception) = if (stopped()) TransferFailure("cancelled", 0, "Stopped") else TransferFailure("network", 0, "Connection failed (${e.javaClass.simpleName})")
}

/** The pure parts of continuing a transfer, unit-tested on the JVM. */
object TransferResume {
    /** What `If-Range` may carry: a strong ETag (a weak one never matches there), else Last-Modified. */
    fun validatorOf(etag: String?, lastModified: String?): String? {
        val e = etag?.trim()
        if (!e.isNullOrEmpty() && !e.startsWith("W/") && e.startsWith("\"")) return e
        val m = lastModified?.trim()
        return if (m.isNullOrEmpty()) null else m
    }

    /** The validator kept for a partial file of this address, or null when there is nothing to continue. */
    fun validatorFor(meta: File, url: String, part: File): String? {
        if (!part.isFile || part.length() <= 0 || !meta.isFile) return null
        return try {
            val o = JSONObject(meta.readText())
            if (o.optString("url") != url) null else o.optString("validator").ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    private val CONTENT_RANGE = Regex("^\\s*bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)\\s*$", RegexOption.IGNORE_CASE)

    /** The first byte a `Content-Range: bytes a-b/n` answer carries. */
    fun rangeStart(header: String?): Long? = header?.let { CONTENT_RANGE.matchEntire(it) }?.groupValues?.get(1)?.toLongOrNull()

    /** The whole file's size from `Content-Range`, when the server says it. */
    fun rangeTotal(header: String?): Long? = header?.let { CONTENT_RANGE.matchEntire(it) }?.groupValues?.get(3)?.toLongOrNull()
}
