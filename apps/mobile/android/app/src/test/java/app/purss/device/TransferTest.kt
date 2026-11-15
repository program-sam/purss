package app.purss.device

import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Transfers cut off and continued, against a local server that can drop the connection part-way. */
class TransferTest {
    private lateinit var server: ServerSocket
    private lateinit var dir: File
    private var body = ByteArray(200_000) { (it % 251).toByte() }
    private var etag: String? = "\"v1\""
    private var lastModified: String? = null
    private var honourRange = true
    /** Bytes of the body sent before the connection drops; null sends it all. */
    private var cutAfter: Int? = null
    private var answerRangeWith416 = false
    private val ranges = mutableListOf<String?>()

    @Before fun setUp() {
        dir = Files.createTempDirectory("transfer-test").toFile()
        server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                try { answer(socket) } catch (_: Exception) { } finally { socket.close() }
            }
        }.apply { isDaemon = true }.start()
    }

    /** One request, one answer, then the connection closes (a cut-off answer stops part-way through its body). */
    private fun answer(socket: Socket) {
        val input = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
        input.readLine() ?: return
        val headers = HashMap<String, String>()
        while (true) {
            val line = input.readLine() ?: break
            if (line.isEmpty()) break
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        val range = headers["range"]
        val ifRange = headers["if-range"]
        ranges.add(range)
        val out = socket.getOutputStream()
        val head = StringBuilder()
        etag?.let { head.append("ETag: $it\r\n") }
        lastModified?.let { head.append("Last-Modified: $it\r\n") }
        if (range != null && answerRangeWith416) {
            out.write("HTTP/1.1 416 Range Not Satisfiable\r\n${head}Content-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            out.flush()
            return
        }
        val current = ifRange == null || ifRange == etag || ifRange == lastModified
        val start = range?.removePrefix("bytes=")?.removeSuffix("-")?.toIntOrNull()
        val (status, from) = if (range != null && start != null && honourRange && current) 206 to start else 200 to 0
        if (status == 206) head.append("Content-Range: bytes $from-${body.size - 1}/${body.size}\r\n")
        val rest = body.copyOfRange(from, body.size)
        val reason = if (status == 206) "Partial Content" else "OK"
        out.write("HTTP/1.1 $status $reason\r\n${head}Content-Length: ${rest.size}\r\nConnection: close\r\n\r\n".toByteArray())
        val n = cutAfter?.let { minOf(it, rest.size) } ?: rest.size
        out.write(rest, 0, n)
        out.flush()
        // A cut-off answer happens once; the next request is served in full.
        cutAfter = null
    }

    @After fun tearDown() {
        server.close()
        dir.deleteRecursively()
    }

    private val url get() = "http://127.0.0.1:${server.localPort}/file"
    private val dest get() = File(dir, "a/episode.mp3")
    private val part get() = File(dest.path + ".part")
    private val meta get() = File(dest.path + ".part.json")

    private fun failing(t: Transfer): TransferFailure {
        try { t.run() } catch (e: TransferFailure) { return e }
        fail("expected a failure")
        throw AssertionError()
    }

    @Test fun aCutOffTransferIsContinuedFromWhereItStopped() {
        cutAfter = 80_000
        val e = failing(Transfer(url, dest, null))
        assertEquals("network", e.code)
        assertTrue(part.exists())
        assertTrue(meta.exists())
        assertEquals(80_000L, part.length())

        val bytes = Transfer(url, dest, null).run()
        assertEquals(body.size.toLong(), bytes)
        assertArrayEquals(body, dest.readBytes())
        assertEquals("bytes=80000-", ranges.last())
        assertFalse(part.exists())
        assertFalse(meta.exists())
    }

    @Test fun aChangedFileStartsAgainFromNothing() {
        cutAfter = 50_000
        failing(Transfer(url, dest, null))
        etag = "\"v2\""
        body = ByteArray(120_000) { (it % 13).toByte() }
        Transfer(url, dest, null).run()
        assertArrayEquals(body, dest.readBytes())
    }

    @Test fun aServerThatIgnoresRangeSendsTheWholeFileAgain() {
        cutAfter = 50_000
        failing(Transfer(url, dest, null))
        honourRange = false
        Transfer(url, dest, null).run()
        assertArrayEquals(body, dest.readBytes())
    }

    @Test fun anUnsatisfiableRangeStartsAgain() {
        cutAfter = 50_000
        failing(Transfer(url, dest, null))
        answerRangeWith416 = true
        Transfer(url, dest, null).run()
        assertArrayEquals(body, dest.readBytes())
        assertEquals(listOf(null, "bytes=50000-", null), ranges)
    }

    @Test fun withoutAValidatorNothingIsKeptToContinue() {
        etag = null
        cutAfter = 50_000
        failing(Transfer(url, dest, null))
        assertFalse(part.exists())
        assertFalse(meta.exists())
    }

    @Test fun lastModifiedServesWhenTheEtagIsWeak() {
        etag = "W/\"weak\""
        lastModified = "Wed, 21 Oct 2015 07:28:00 GMT"
        cutAfter = 50_000
        failing(Transfer(url, dest, null))
        Transfer(url, dest, null).run()
        assertArrayEquals(body, dest.readBytes())
        assertEquals("bytes=50000-", ranges.last())
    }

    @Test fun stoppedByHandRemovesThePartialFileButAPauseKeepsIt() {
        var calls = 0
        val paused = Transfer(url, dest, null, shouldStop = { ++calls > 2 })
        assertEquals("cancelled", failing(paused).code)
        assertTrue(part.exists())

        val t = Transfer(url, dest, null, onProgress = { _, _ -> })
        t.cancel(discard = true)
        assertEquals("cancelled", failing(t).code)
        assertFalse(part.exists())
        assertFalse(meta.exists())
    }

    @Test fun theWholeSizeFromContentRangeStillCountsAgainstTheLimit() {
        cutAfter = 50_000
        failing(Transfer(url, dest, null))
        val e = failing(Transfer(url, dest, 100_000))
        assertEquals("too_large", e.code)
        assertFalse(part.exists())
    }

    @Test fun readsContentRange() {
        assertEquals(10L, TransferResume.rangeStart("bytes 10-99/100"))
        assertEquals(100L, TransferResume.rangeTotal("bytes 10-99/100"))
        assertNull(TransferResume.rangeTotal("bytes 10-99/*"))
        assertNull(TransferResume.rangeStart("bytes */100"))
        assertNull(TransferResume.validatorOf("W/\"x\"", null))
        assertEquals("\"x\"", TransferResume.validatorOf("\"x\"", "Wed"))
    }
}
