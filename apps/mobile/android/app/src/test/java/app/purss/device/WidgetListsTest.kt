package app.purss.device

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The home-screen panels' lists (plan/38), against the table the page's test reads too (apps/mobile/widget-lists.json). */
class WidgetListsTest {
    private val fixture = JSONObject(File("../../widget-lists.json").readText())

    @Test fun eachListAsksWhatTheTableSays() {
        val lists = fixture.getJSONArray("lists")
        for (i in 0 until lists.length()) {
            val l = lists.getJSONObject(i)
            val key = l.getString("key")
            assertTrue(key, WidgetLists.isKey(key))
            assertEquals(key, l.getString("path"), WidgetLists.path(key))
            assertTrue(key, WidgetLists.path(key)!!.contains("exceptPrivate=1"))
        }
        val invalid = fixture.getJSONArray("invalid")
        for (i in 0 until invalid.length()) {
            assertFalse(invalid.getString(i), WidgetLists.isKey(invalid.getString(i)))
            assertNull(invalid.getString(i), WidgetLists.path(invalid.getString(i)))
        }
    }

    @Test fun aPageBecomesRowsWithTheirDates() {
        val page = """{"items":[
            {"id":"itm_1","title":"  ","sourceTitle":"A","publishedAt":null,"discoveredAt":"2026-11-12T08:00:00.000Z"},
            {"id":"../x","title":"Bad","sourceTitle":"B","publishedAt":null,"discoveredAt":"2026-11-12T08:00:00.000Z"},
            {"id":"itm_2","title":"${"x".repeat(300)}","sourceTitle":"B","publishedAt":"2026-11-11T08:00:00+02:00","discoveredAt":"2026-11-12T08:00:00.000Z"}
        ],"nextCursor":null,"total":null}"""
        val (rows, total) = WidgetLists.parsePage(page)
        assertEquals(listOf("itm_1", "itm_2"), rows.map { it.id })
        assertEquals("Untitled", rows[0].title)
        assertEquals("2026-11-12T08:00:00.000Z", rows[0].at)
        assertEquals("2026-11-11T08:00:00+02:00", rows[1].at)
        assertEquals(200, rows[1].title.length)
        assertNull("typed lists have no total", total)
        val many = """{"items":[${(1..12).joinToString(",") { """{"id":"itm_$it","title":"T","sourceTitle":"S","discoveredAt":"2026-11-12T08:00:00.000Z"}""" }}],"total":12}"""
        assertEquals(WidgetLists.ROWS, WidgetLists.parsePage(many).first.size)
        assertEquals(12L, WidgetLists.parsePage(many).second)
    }

    @Test fun timesAsThePurssWritesThem() {
        assertEquals(1_762_934_400_000L, WidgetLists.millis("2025-11-12T08:00:00.000Z"))
        assertEquals(1_762_934_400_000L, WidgetLists.millis("2025-11-12T10:00:00+02:00"))
        assertNull(WidgetLists.millis("yesterday"))
        assertNull(WidgetLists.millis("2025-11-12T08:00:00.000Zjunk"))
    }

    @Test fun theCatalogLeavesPrivateSourcesOutOfSetupAndSaysWhenAChoiceIsGone() {
        val boot = """{"collections":[{"id":"col_a","name":"Science","emoji":"🔬"},{"id":"col_b","name":"News","emoji":null}],
            "sources":[{"id":"src_z","title":"zeta","kind":"feed"},{"id":"src_p","title":"Diary","kind":"private"},{"id":"src_a","title":"Alpha","kind":"podcast"}],
            "baskets":[],"preferences":{}}"""
        val c = WidgetLists.parseCatalog(boot)
        assertEquals(listOf("🔬 Science", "News"), c.choices("collection").map { it.name })
        assertEquals(listOf("source:src_a", "source:src_z"), c.choices("source").map { it.key })
        assertEquals("ok", WidgetLists.chosenState("collection:col_a", c))
        assertEquals("private", WidgetLists.chosenState("source:src_p", c))
        assertEquals("gone", WidgetLists.chosenState("source:src_removed", c))
        assertEquals("gone", WidgetLists.chosenState("collection:col_removed", c))
    }

    @Test fun storedListsAndChoicesReadBackAndDamageReadsAsNothing() {
        val lists = mapOf(
            "toread" to WidgetLists.Stored(listOf(WidgetLists.Row("itm_1", "T", "S", null)), 3, "ok", null),
            "collection:col_a" to WidgetLists.Stored(emptyList(), null, "loading", "Science"),
        )
        assertEquals(lists, WidgetLists.decode(WidgetLists.encode(lists)))
        assertEquals(emptyMap<String, WidgetLists.Stored>(), WidgetLists.decode("{"))
        assertEquals(emptyMap<String, WidgetLists.Stored>(), WidgetLists.decode("""{"basket:bsk_1":{"rows":[],"state":"ok"}}"""))
        val choices = mapOf(7 to "collection:col_a", 9 to "source:src_a")
        assertEquals(choices, WidgetLists.decodeChoices(WidgetLists.encodeChoices(choices)))
        assertEquals(emptyMap<Int, String>(), WidgetLists.decodeChoices("""{"7":"toread","x":"source:src_a","8":"source:../x"}"""))
    }

    @Test fun rowsFitThePanelsHeight() {
        assertEquals(4, WidgetLists.rowsFor(0, false))
        assertEquals(1, WidgetLists.rowsFor(80, true))
        assertEquals(2, WidgetLists.rowsFor(160, false))
        assertEquals(WidgetLists.ROWS, WidgetLists.rowsFor(2000, true))
    }

    @Test fun aWriteThatStartedBeforeADisconnectIsDropped() {
        val since = WidgetData.generation
        assertEquals("written", WidgetData.ifCurrent(since) { "written" })
        WidgetData.invalidate()
        assertNull("a refresh or setup from before the wipe writes nothing", WidgetData.ifCurrent(since) { "written" })
        assertEquals("written", WidgetData.ifCurrent(WidgetData.generation) { "written" })
    }

    @Test fun sourceTilesMatchTheApp() {
        // Expected values from the web app's own initialsOf and hashHue (apps/web/src/components/item-bits.tsx).
        val expected = mapOf("City Desk" to (270 to "CD"), "Tidal Notes" to (11 to "TN"), "Slow Radio" to (52 to "SR"), "Slashdot" to (340 to "SL"),
            "99% Invisible" to (338 to "9I"), "Saved link" to (3 to "SL"), "Café Crème" to (202 to "CC"))
        for ((name, v) in expected) {
            assertEquals(name, v.first, WidgetLists.hue(name))
            assertEquals(name, v.second, WidgetLists.initials(name))
        }
        assertEquals(0xffff0000.toInt(), WidgetLists.hsv(0, 1f, 1f))
        assertEquals(0xff0000ff.toInt(), WidgetLists.hsv(240, 1f, 1f))
        assertEquals(0xffffffff.toInt(), WidgetLists.hsv(123, 0f, 1f))
        assertTrue("a tile is pale by day and deep at night", (WidgetLists.avatarTile(212, false) and 0xff) > (WidgetLists.avatarTile(212, true) and 0xff))
    }
}
