package app.purss.device

import org.json.JSONArray
import org.json.JSONObject

/**
 * The home-screen panels' lists (plan/38), apart from Android so they are unit-tested on the JVM. A list key
 * is `toread`, `tolisten`, `new`, `collection:<id>` or `source:<id>`; each has one request (the table in
 * apps/mobile/widget-lists.json, which the tests read). Lists hold titles, ids and dates: never the token or
 * the PURSS's address, and never items of private sources (`exceptPrivate=1`).
 */
object WidgetLists {
    /** The most rows a panel shows. */
    const val ROWS = 8
    private const val LIMIT = 10
    private val KEY = Regex("^(toread|tolisten|new|(collection|source):[a-z0-9_]{1,64})$")

    fun isKey(key: String?): Boolean = key != null && KEY.matches(key)
    fun configurable(key: String) = key.startsWith("collection:") || key.startsWith("source:")

    /** The request for a list, or null for anything that isn't a key. */
    fun path(key: String): String? {
        if (!isKey(key)) return null
        val tail = "&limit=$LIMIT&exceptPrivate=1"
        return when (key) {
            "toread" -> "/api/items?scope=toread&filter=active&sort=newest&type=articles,videos$tail"
            "tolisten" -> "/api/items?scope=toread&filter=active&sort=oldest&type=podcasts$tail"
            "new" -> "/api/items?scope=all&filter=fresh&sort=newest$tail"
            else -> "/api/items?scope=${key.replace(":", "%3A")}&filter=active&sort=newest$tail"
        }
    }

    data class Row(val id: String, val title: String, val sourceTitle: String, val at: String?)

    /**
     * A list as stored. `state`: `ok`; `gone` (the chosen collection or source is no longer in the PURSS);
     * `private` (the chosen source is private, so nothing of it shows on a home screen). `name` is the chosen
     * collection's or source's name, null for the fixed lists.
     */
    data class Stored(val rows: List<Row>, val total: Long?, val state: String, val name: String?)

    /** The answer of a list request: up to ROWS rows, items whose id couldn't be a plain id left out. */
    fun parsePage(text: String): Pair<List<Row>, Long?> {
        val p = JSONObject(text)
        val items = p.getJSONArray("items")
        val rows = (0 until items.length()).mapNotNull { i ->
            val it = items.getJSONObject(i)
            val id = it.optString("id")
            if (!Paths.isId(id)) null
            else Row(id, clip(it.optString("title").trim().ifEmpty { "Untitled" }), clip(it.optString("sourceTitle")),
                (if (it.isNull("publishedAt")) null else it.optString("publishedAt")) ?: it.optString("discoveredAt").ifEmpty { null })
        }.take(ROWS)
        return rows to (if (p.isNull("total")) null else p.optLong("total"))
    }

    data class Choice(val key: String, val name: String)

    /**
     * What the PURSS's `/api/bootstrap` says about collections and followed sources, reduced to keys and names:
     * the panels' setup lists and the check that a chosen one still exists. Private sources are kept here with
     * `private = true` so a chosen source that became private can say so; setup leaves them out.
     */
    data class Catalog(val collections: List<Choice>, val sources: List<Choice>, val privateSources: Set<String>) {
        fun name(key: String): String? = (collections + sources).firstOrNull { it.key == key }?.name
        fun choices(kind: String): List<Choice> = if (kind == "collection") collections else sources.filter { it.key !in privateSources }
    }

    fun parseCatalog(text: String): Catalog {
        val o = JSONObject(text)
        val cols = o.optJSONArray("collections") ?: JSONArray()
        val srcs = o.optJSONArray("sources") ?: JSONArray()
        val collections = (0 until cols.length()).mapNotNull { i ->
            val c = cols.getJSONObject(i)
            val key = "collection:${c.optString("id")}"
            if (!isKey(key)) null else {
                val emoji = if (c.isNull("emoji")) "" else c.optString("emoji")
                Choice(key, clip(listOf(emoji, c.optString("name")).filter { it.isNotBlank() }.joinToString(" ")))
            }
        }
        val sourcesList = mutableListOf<Choice>()
        val privateSet = mutableSetOf<String>()
        for (i in 0 until srcs.length()) {
            val s = srcs.getJSONObject(i)
            val key = "source:${s.optString("id")}"
            if (!isKey(key)) continue
            sourcesList += Choice(key, clip(s.optString("title")))
            if (s.optString("kind") == "private") privateSet += key
        }
        return Catalog(collections, sourcesList.sortedBy { it.name.lowercase() }, privateSet)
    }

    /** A chosen list's state from the catalog: gone when the PURSS no longer has it, private for a private source. */
    fun chosenState(key: String, catalog: Catalog): String = when {
        catalog.name(key) == null -> "gone"
        key in catalog.privateSources -> "private"
        else -> "ok"
    }

    fun encode(lists: Map<String, Stored>): String {
        val o = JSONObject()
        for ((key, s) in lists) {
            val rows = JSONArray()
            for (r in s.rows) rows.put(JSONObject().put("id", r.id).put("title", r.title).put("sourceTitle", r.sourceTitle).put("at", r.at ?: JSONObject.NULL))
            o.put(key, JSONObject().put("rows", rows).put("total", s.total ?: JSONObject.NULL).put("state", s.state).put("name", s.name ?: JSONObject.NULL))
        }
        return o.toString()
    }

    /** The stored lists; damaged entries and unknown keys are left out. */
    fun decode(json: String?): Map<String, Stored> = try {
        val o = JSONObject(json ?: "{}")
        o.keys().asSequence().filter { isKey(it) }.mapNotNull { key ->
            try {
                val s = o.getJSONObject(key)
                val rows = s.getJSONArray("rows")
                key to Stored(
                    (0 until rows.length()).map { i ->
                        val r = rows.getJSONObject(i)
                        Row(r.getString("id"), r.optString("title"), r.optString("sourceTitle"), if (r.isNull("at")) null else r.optString("at"))
                    }.filter { Paths.isId(it.id) },
                    if (s.isNull("total")) null else s.optLong("total"),
                    s.optString("state", "ok"),
                    if (s.isNull("name")) null else s.optString("name"),
                )
            } catch (e: Exception) { null }
        }.toMap()
    } catch (e: Exception) {
        emptyMap()
    }

    /** Which list each placed configurable panel shows (`{"<appWidgetId>": "<key>"}`). */
    fun decodeChoices(json: String?): Map<Int, String> = try {
        val o = JSONObject(json ?: "{}")
        o.keys().asSequence().mapNotNull { k -> k.toIntOrNull()?.let { id -> o.optString(k).takeIf { isKey(it) && configurable(it) }?.let { id to it } } }.toMap()
    } catch (e: Exception) {
        emptyMap()
    }

    fun encodeChoices(choices: Map<Int, String>): String = JSONObject().apply { for ((id, key) in choices) put(id.toString(), key) }.toString()

    /**
     * How many rows fit a panel `heightDp` tall (the smallest height the launcher reports). The header takes
     * about 40 dp and the episode block 64 dp; a row (two lines of title, one of source) about 58 dp.
     */
    fun rowsFor(heightDp: Int, episode: Boolean): Int {
        if (heightDp <= 0) return 4
        val free = heightDp - 40 - (if (episode) 64 else 0)
        return (free / 58).coerceIn(1, ROWS)
    }

    /** An ISO time as the PURSS writes it (`2026-11-12T09:30:00.000Z`, or with an offset), in milliseconds; null for anything else. */
    fun millis(iso: String): Long? {
        for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX")) {
            try {
                val f = java.text.SimpleDateFormat(pattern, java.util.Locale.US).apply { isLenient = false }
                val pos = java.text.ParsePosition(0)
                val d = f.parse(iso, pos)
                if (d != null && pos.index == iso.length) return d.time
            } catch (e: Exception) { /* the next pattern */ }
        }
        return null
    }

    /** A source's initials as the app makes them (apps/web/src/components/item-bits.tsx initialsOf). */
    fun initials(name: String): String {
        val words = name.replace(Regex("[^\\p{L}\\p{N} ]"), " ").split(Regex("\\s+")).filter { it.isNotEmpty() }
        val first = words.firstOrNull()?.firstOrNull()?.toString() ?: "?"
        val second = if (words.size > 1) words[1].first().toString() else words.firstOrNull()?.getOrNull(1)?.toString() ?: ""
        return (first + second).uppercase()
    }

    /** The app's stable hue for a name (item-bits.tsx hashHue): over UTF-16 units, h = h * 31 + unit, modulo 2^32. */
    fun hue(name: String): Int {
        var h = 0L
        for (c in name) h = (h * 31 + c.code) and 0xffffffffL
        return (h % 360).toInt()
    }

    /** A source tile's colour for a hue, light or night (the app's .av: a pale tint, or a deep one at night). */
    fun avatarTile(hue: Int, night: Boolean): Int = hsv(hue, if (night) 0.35f else 0.10f, if (night) 0.32f else 0.98f)
    fun avatarInk(hue: Int, night: Boolean): Int = hsv(hue, if (night) 0.18f else 0.75f, if (night) 0.94f else 0.36f)

    /** HSV to opaque ARGB, apart from android.graphics.Color so it runs on the JVM. */
    fun hsv(hue: Int, s: Float, v: Float): Int {
        val c = v * s
        val hp = (hue % 360) / 60f
        val x = c * (1 - kotlin.math.abs(hp % 2 - 1))
        val (r, g, b) = when (hp.toInt()) {
            0 -> Triple(c, x, 0f); 1 -> Triple(x, c, 0f); 2 -> Triple(0f, c, x)
            3 -> Triple(0f, x, c); 4 -> Triple(x, 0f, c); else -> Triple(c, 0f, x)
        }
        val m = v - c
        fun ch(f: Float) = Math.round((f + m) * 255).coerceIn(0, 255)
        return (0xff shl 24) or (ch(r) shl 16) or (ch(g) shl 8) or ch(b)
    }

    private fun clip(s: String) = if (s.length > 200) s.substring(0, 199) + "…" else s
}
