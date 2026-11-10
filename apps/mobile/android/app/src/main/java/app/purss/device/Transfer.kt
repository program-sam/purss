package app.purss.device

import java.io.File
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
 * half-written file never has the real name. `cancel()` closes the connection at once; the partial file
 * is removed whatever ends the transfer. Blocking: run it off the main thread.
 */
class Transfer(
    private val url: String,
    private val dest: File,
    private val maxBytes: Long?,
    private val onProgress: (bytes: Long, total: Long) -> Unit = { _, _ -> },
    private val shouldStop: () -> Boolean = { false },
) {
    @Volatile private var cancelled = false
    @Volatile private var connection: HttpURLConnection? = null

    fun cancel() {
        cancelled = true
        connection?.disconnect()
    }

    private fun stopped() = cancelled || shouldStop()

    fun run(): Long {
        val u = try { URL(url) } catch (e: Exception) { throw TransferFailure("network", 0, "Not a web address") }
        if (u.protocol != "https" && u.protocol != "http") throw TransferFailure("network", 0, "Not a web address")
        val part = File(dest.path + ".part")
        try {
            dest.parentFile?.mkdirs()
            val conn = u.openConnection() as HttpURLConnection
            connection = conn
            if (stopped()) throw TransferFailure("cancelled", 0, "Stopped")
            conn.connectTimeout = 20_000
            conn.readTimeout = 60_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("Accept-Encoding", "identity")
            val status = try { conn.responseCode } catch (e: IOException) { throw failure(e) }
            if (status !in 200..299) throw TransferFailure("http", status, "HTTP $status")
            val total = conn.contentLengthLong
            if (maxBytes != null && total > maxBytes) throw TransferFailure("too_large", 0, "Larger than allowed")
            var bytes = 0L
            var told = 0L
            try {
                conn.inputStream.use { input ->
                    part.outputStream().use { out ->
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
            if (dest.exists()) dest.delete()
            if (!part.renameTo(dest)) throw TransferFailure("io", 0, "Couldn't write the file")
            return bytes
        } catch (e: TransferFailure) {
            part.delete()
            throw e
        } catch (e: Exception) {
            part.delete()
            throw failure(e)
        } finally {
            connection?.disconnect()
            connection = null
        }
    }

    /** The message names the kind of failure only: an exception's own message can carry the address. */
    private fun failure(e: Exception) = if (stopped()) TransferFailure("cancelled", 0, "Stopped") else TransferFailure("network", 0, "Connection failed (${e.javaClass.simpleName})")
}
