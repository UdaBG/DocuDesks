package com.docudesk.lite

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Keep the web app out from under the status/navigation bars: pad the
    // content view by the system bar (and keyboard) insets and paint the
    // uncovered strips in the app's chrome colour. Android's WebView cannot
    // be relied on to expose these insets as CSS safe-area values.
    val content = findViewById<android.view.ViewGroup>(android.R.id.content)
    content.setBackgroundColor(Color.parseColor("#F8F9FB"))
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    // Light chrome behind both bars, so the icons must be dark.
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = true
      isAppearanceLightNavigationBars = true
    }
  }

  /**
   * Safety net for file picks. Tauri's PluginManager keeps a single
   * in-memory result callback and never re-registers it when Android
   * recreates this activity while the document picker is in front — the
   * pick result is then dropped, or replayed into the NEXT pick's callback
   * (documents appearing one pick late). Every activity result physically
   * passes through here first, so successful picks are ALSO forwarded
   * straight to the web app, which de-duplicates already-open files. The
   * save dialog also passes through here; the web app suppresses those (it
   * knows when its own save is in flight) so its output isn't re-imported.
   */
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (resultCode != RESULT_OK || data == null) return
    val uris = mutableListOf<String>()
    data.data?.let { uris.add(it.toString()) }
    data.clipData?.let { clip ->
      for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri.toString())
    }
    if (uris.isEmpty()) return
    val json = JSONArray(uris).toString()
    val root = window.decorView
    var attempts = 0
    // the web app may still be booting (process recreated behind the
    // picker) — retry until the hook exists
    lateinit var deliver: Runnable
    deliver = Runnable {
      val wv = findWebView(root)
      if (wv != null) {
        wv.evaluateJavascript(
          "window.__androidPickedFiles ? window.__androidPickedFiles($json) : false"
        ) { result ->
          if (result == "false" && attempts++ < 20) root.postDelayed(deliver, 500)
        }
      } else if (attempts++ < 20) {
        root.postDelayed(deliver, 500)
      }
    }
    root.postDelayed(deliver, 300)
  }

  private fun findWebView(v: View?): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) {
        findWebView(v.getChildAt(i))?.let { return it }
      }
    }
    return null
  }
}
