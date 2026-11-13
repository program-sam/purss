package app.purss.device

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import app.purss.R

/**
 * Choosing what a collection or source panel shows (plan/38): the launcher opens this when such a panel is
 * placed, on Android 12 and later when it is reconfigured, and a panel whose choice is gone opens it when tapped.
 * It lists the PURSS's collections, or its sources without the private ones, from `/api/bootstrap` (read with
 * the device token, as the background job reads it); only the chosen key and name are kept.
 */
class WidgetSetupActivity : AppCompatActivity() {
    private val pool = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Leaving without a choice doesn't place the panel.
        setResult(Activity.RESULT_CANCELED)
        widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        val kind = Panels.kindOf(this, widgetId)
        if (kind != "collection" && kind != "source") { finish(); return }

        val pad = dp(20)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, dp(8)) }
        val heading = TextView(this).apply {
            text = getString(if (kind == "collection") R.string.widget_choose_collection_title else R.string.widget_choose_source_title)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setTextColor(ContextCompat.getColor(context, R.color.widget_accent))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }
        val note = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(ContextCompat.getColor(context, R.color.widget_ink_2))
            setPadding(0, dp(12), 0, dp(12))
            visibility = View.GONE
        }
        val spinner = ProgressBar(this).apply { setPadding(0, dp(16), 0, dp(16)) }
        val list = ListView(this).apply { dividerHeight = 0; visibility = View.GONE }
        root.addView(heading)
        root.addView(note)
        root.addView(spinner)
        root.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(360)))
        setContentView(root)

        val since = WidgetData.generation
        pool.execute {
            val conn = StoredConnection.read(this)
            val result: Result<List<WidgetLists.Choice>>? = if (conn == null) null else try {
                val a = WorkspaceApi(conn).get("/api/bootstrap")
                if (a.status == 200) Result.success(WidgetLists.parseCatalog(a.text).choices(kind)) else Result.failure(Exception("${a.status}"))
            } catch (e: Refused) {
                WidgetData.lost(this, since)
                null
            } catch (e: Exception) {
                Result.failure(e)
            }
            main.post {
                if (isFinishing) return@post
                spinner.visibility = View.GONE
                val choices = result?.getOrNull()
                when {
                    result == null -> { note.text = getString(R.string.widget_not_connected); note.visibility = View.VISIBLE }
                    choices == null -> { note.text = getString(R.string.widget_setup_failed); note.visibility = View.VISIBLE }
                    choices.isEmpty() -> {
                        note.text = getString(if (kind == "collection") R.string.widget_no_collections else R.string.widget_no_sources)
                        note.visibility = View.VISIBLE
                    }
                    else -> {
                        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, choices.map { it.name })
                        list.visibility = View.VISIBLE
                        list.onItemClickListener = AdapterView.OnItemClickListener { _, _, i, _ -> choose(choices[i], since) }
                    }
                }
            }
        }
    }

    private fun choose(choice: WidgetLists.Choice, since: Long) {
        // A disconnect while this was open: the choice belongs to the old connection, so it isn't kept.
        val kept = WidgetData.ifCurrent(since) {
            val choices = WidgetLists.decodeChoices(DeviceStore.choices(this)) + (widgetId to choice.key)
            DeviceStore.setChoices(this, WidgetLists.encodeChoices(choices))
            // The name shows at once; the rows come with the refresh.
            val lists = WidgetLists.decode(DeviceStore.lists(this)).toMutableMap()
            if (lists[choice.key]?.state != "ok") lists[choice.key] = WidgetLists.Stored(emptyList(), null, "loading", choice.name)
            DeviceStore.setLists(this, WidgetLists.encode(lists))
        }
        if (kept == null) { finish(); return }
        Panels.redraw(this, widgetId)
        WidgetRefresh.soon(this)
        setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        finish()
    }

    override fun onDestroy() {
        pool.shutdownNow()
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
