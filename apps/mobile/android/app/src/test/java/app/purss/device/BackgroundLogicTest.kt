package app.purss.device

import java.io.File
import java.util.Date
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The page's formats as the background job reads and writes them (apps/web/src/downloads/background.ts). */
class BackgroundLogicTest {
    private val stateJson = """{"accountId":"acc_1","origin":"https://ws.example","settings":{"autoToRead":true,"wifiOnly":true,"limitBytes":100,"removeFinished":false},"have":["itm_1"],"usedBytes":40}"""
    private val at = Date(1_762_400_000_000)

    @Test fun readsTheMirroredState() {
        val s = BackgroundLogic.parseState(stateJson)!!
        assertEquals("acc_1", s.accountId)
        assertTrue(s.wantsDownloads)
        assertEquals(60L, s.room)
        assertEquals(listOf("itm_1"), s.have)
        assertNull(BackgroundLogic.parseState(null))
        assertNull(BackgroundLogic.parseState("{"))
        assertNull(BackgroundLogic.parseState(stateJson.replace("acc_1", "../x")))
    }

    @Test fun roomNeverExceedsTheLargestDownloadNorGoesBelowZero() {
        val big = BackgroundLogic.parseState(stateJson.replace("\"limitBytes\":100", "\"limitBytes\":${10L * 1024 * 1024 * 1024}"))!!
        assertEquals(BackgroundLogic.MAX_DOWNLOAD_BYTES, big.room)
        val over = BackgroundLogic.parseState(stateJson.replace("\"usedBytes\":40", "\"usedBytes\":400"))!!
        assertEquals(0L, over.room)
    }

    @Test fun planRequestAndAfterDownload() {
        val s = BackgroundLogic.parseState(stateJson)!!
        val req = JSONObject(BackgroundLogic.planRequest(s))
        assertEquals(40L, req.getLong("usedBytes"))
        assertEquals("itm_1", req.getJSONArray("have").getString(0))
        assertFalse(req.has("wifiOnly"))
        val after = BackgroundLogic.parseState(BackgroundLogic.afterDownload(stateJson, "itm_2", 10))!!
        assertEquals(listOf("itm_1", "itm_2"), after.have)
        assertEquals(50L, after.usedBytes)
    }

    @Test fun planItemsWithUnsafeIdsOrFileNamesAreLeftOut() {
        val plan = """{"items":[
          {"id":"itm_2","expectedBytes":5,"media":{"kind":"audio","url":"https://x/a.mp3","type":"audio/mpeg","declaredBytes":5,"file":"media.mp3"}},
          {"id":"../etc","expectedBytes":5,"media":{"kind":"audio","url":"https://x/a.mp3","type":null,"declaredBytes":null,"file":"media.mp3"}},
          {"id":"itm_3","expectedBytes":5,"media":{"kind":"audio","url":"https://x/a","type":null,"declaredBytes":null,"file":"../../x"}},
          {"id":"itm_5","expectedBytes":5,"media":{"kind":"audio","url":null,"type":null,"declaredBytes":null,"file":"media.mp3"}},
          {"id":"itm_4","expectedBytes":5,"media":{"kind":"video","url":"https://x/a","type":null,"declaredBytes":null,"file":"media"}}]}"""
        val items = BackgroundLogic.parsePlan(plan)
        assertEquals(listOf("itm_2", "itm_4"), items.map { it.id })
        assertEquals("https://x/a.mp3", items[0].url)
        assertNull(items[1].declaredBytes)
    }

    @Test fun recordsAreWhatThePageAdopts() {
        val d = BackgroundLogic.parseDetail("""{"title":"One","sourceTitle":"Slow Radio","kind":"podcast","annotatedAt":"2026-11-01T00:00:00Z"}""")
        assertTrue(d.annotated)
        assertFalse(BackgroundLogic.parseDetail("""{"title":"One","annotatedAt":null}""").annotated)
        val p = BackgroundLogic.PlanItem("itm_2", "https://x/a.mp3", "audio/mpeg", "audio", 5, "media.mp3")
        val done = JSONObject(BackgroundLogic.doneRecord("acc_1", "itm_2", d, p, 1234, 99, at))
        assertEquals("done", done.getString("state"))
        assertTrue(done.isNull("status"))
        assertEquals("acc_1/itm_2/media.mp3", done.getJSONObject("media").getString("file"))
        assertEquals(1234L, done.getJSONObject("media").getLong("bytes"))
        assertFalse(done.getJSONObject("media").has("from"))
        assertEquals(99L, done.getLong("textBytes"))
        assertEquals("2025-11-06T03:33:20.000Z", done.getString("savedAt"))
        val failed = JSONObject(BackgroundLogic.failedRecord("itm_2", d, -2, at))
        assertEquals(-2, failed.getInt("status"))
        assertTrue(failed.isNull("media"))
    }

    @Test fun aFinishedItemIsKeptOnlyWhileTheStateIsStillThisAccounts() {
        assertTrue(BackgroundLogic.mayKeep(stateJson, "acc_1", stopped = false))
        assertFalse("wiped by a disconnect during the transfer", BackgroundLogic.mayKeep(null, "acc_1", stopped = false))
        assertFalse("another account since", BackgroundLogic.mayKeep(stateJson, "acc_2", stopped = false))
        assertFalse("the job was stopped", BackgroundLogic.mayKeep(stateJson, "acc_1", stopped = true))
    }

    @Test fun thePluginDownloadsOnlyHttpsAndNeverPastTheLargestSize() {
        assertTrue(BackgroundLogic.downloadAllowed("https://cdn.example/a.mp3"))
        assertTrue(BackgroundLogic.downloadAllowed("HTTPS://cdn.example/a.mp3"))
        assertFalse(BackgroundLogic.downloadAllowed("http://cdn.example/a.mp3"))
        assertFalse(BackgroundLogic.downloadAllowed("file:///data/x"))
        val largest = BackgroundLogic.MAX_DOWNLOAD_BYTES
        assertEquals(largest, BackgroundLogic.downloadCap(null))
        assertEquals(largest, BackgroundLogic.downloadCap(0))
        assertEquals(largest, BackgroundLogic.downloadCap(largest * 2))
        assertEquals(1000L, BackgroundLogic.downloadCap(1000))
    }

    @Test fun onlyA401WithTheSignedOutCodeCountsAsRefused() {
        assertTrue(BackgroundLogic.refusedWith("""{"error":{"code":"device_signed_out","message":"x"}}""", "device_signed_out"))
        assertTrue(BackgroundLogic.refusedWith("""{"error":{"code":"push_signed_out"}}""", "push_signed_out"))
        assertFalse(BackgroundLogic.refusedWith("""{"error":{"code":"push_signed_out"}}""", "device_signed_out"))
        assertFalse(BackgroundLogic.refusedWith("""{"error":{"code":"unauthorized"}}""", "device_signed_out"))
        assertFalse("a proxy's page", BackgroundLogic.refusedWith("<html>401 Authorization Required</html>", "device_signed_out"))
        assertFalse(BackgroundLogic.refusedWith("", "device_signed_out"))
        assertFalse(BackgroundLogic.refusedWith(null, "device_signed_out"))
    }

    @Test fun storedConnections() {
        assertEquals("https://ws.example", StoredConnection.parse("""{"origin":"https://ws.example","token":"purss_dev_abc"}""")!!.origin)
        assertEquals("http://localhost:19990", StoredConnection.parse("""{"origin":"http://localhost:19990","token":"purss_dev_abc"}""")!!.origin)
        assertNull(StoredConnection.parse("""{"origin":"https://ws.example/path","token":"purss_dev_abc"}"""))
        assertNull(StoredConnection.parse("""{"origin":"https://ws.example","token":"other"}"""))
        assertNull(StoredConnection.parse("nope"))
    }

    @Test fun pathsStayInsideTheirFolder() {
        val root = File("/data/downloads")
        assertEquals(File("/data/downloads/acc_1/itm_1/media.mp3"), Paths.under(root, "acc_1/itm_1/media.mp3"))
        for (bad in listOf("", "/etc/passwd", "acc_1/../../x", "acc_1//x", "./x", "acc 1/x", "acc_1/x\u0000")) assertNull(bad, Paths.under(root, bad))
    }
}
