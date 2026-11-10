package app.purss.device

import android.content.Context
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * The connection the page saved (`purss.connection`: the PURSS's origin and the device token), read
 * where @aparajita/capacitor-secure-storage 8.0.1 keeps it on Android: AES-GCM ciphertext and IV in the
 * `WSSecureStorageSharedPreferences` preferences, the key in the Android Keystore under the same alias.
 * Read only, never copied: the page stays the one that saves and removes it. The format is that
 * plugin's; it is pinned, and a change there shows here as "not connected".
 */
object StoredConnection {
    private const val PREFS = "WSSecureStorageSharedPreferences"
    private const val KEY = "capacitor-storage_purss.connection"
    private const val SEPARATOR = '\u0010'
    private const val BASE64 = Base64.NO_PADDING or Base64.NO_WRAP

    data class Connection(val origin: String, val token: String)

    fun read(ctx: Context): Connection? = try {
        val stored = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        val parts = stored?.split(SEPARATOR)
        if (parts == null || parts.size != 2) null else {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val entry = keyStore.getEntry(KEY, null) as? KeyStore.SecretKeyEntry
            if (entry == null) null else {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, entry.secretKey, GCMParameterSpec(128, Base64.decode(parts[1], BASE64)))
                parse(String(cipher.doFinal(Base64.decode(parts[0], BASE64)), Charsets.UTF_8))
            }
        }
    } catch (e: Exception) {
        null
    }

    /** The stored JSON, `{"origin":"https://…","token":"purss_dev_…"}`; anything else isn't a connection. */
    fun parse(json: String): Connection? = try {
        val o = JSONObject(json)
        val origin = o.optString("origin")
        val token = o.optString("token")
        if (!token.startsWith("purss_dev_") || !Regex("^https?://[^/?#]+$").matches(origin)) null else Connection(origin, token)
    } catch (e: Exception) {
        null
    }
}

/** The token was refused (401 `device_signed_out`): the device isn't connected any more. */
class Refused : Exception("The workspace refused this device's token")

/**
 * Requests to the connected PURSS with the device token. Only ever to `origin` + an API path: the
 * token never goes anywhere else (files are fetched without it, from publishers).
 */
class WorkspaceApi(private val conn: StoredConnection.Connection) {
    class Answer(val status: Int, val body: ByteArray) {
        val text get() = String(body, Charsets.UTF_8)
    }

    fun get(path: String): Answer = send("GET", path, null)
    fun post(path: String, json: String): Answer = send("POST", path, json)

    private fun send(method: String, path: String, json: String?): Answer {
        require(path.startsWith("/api/")) { "Only API paths" }
        val conn = URL(this.conn.origin + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 20_000
            conn.readTimeout = 60_000
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("Authorization", "Bearer ${this.conn.token}")
            conn.setRequestProperty("Accept", "application/json")
            if (json != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readBytes() } ?: ByteArray(0)
            // Only the PURSS saying this device is signed out counts; any other 401 is a failure to try again later.
            if (status == 401 && BackgroundLogic.refusedWith(String(body, Charsets.UTF_8), "device_signed_out")) throw Refused()
            return Answer(status, body)
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        fun enc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    }
}
