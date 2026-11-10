package app.purss.device

import java.io.File

/** Relative paths under a folder, refused when they could leave it. Pure, so it is unit-tested on the JVM. */
object Paths {
    private val SEGMENT = Regex("^[A-Za-z0-9._-]{1,128}$")

    /** `root/relative`, or null for an empty, absolute or `..` path, or a segment with anything but plain characters. */
    fun under(root: File, relative: String): File? {
        if (relative.isEmpty() || relative.length > 512) return null
        val segments = relative.split('/')
        if (segments.any { it == "." || it == ".." || !SEGMENT.matches(it) }) return null
        return File(root, segments.joinToString(File.separator))
    }

    /** An item or account id as the PURSS makes them (`itm_…`, `acc_…`). */
    fun isId(value: String): Boolean = Regex("^[A-Za-z0-9_-]{1,64}$").matches(value)
}
