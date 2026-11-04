package com.hari.esp32lab

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val i = Intent(this, ServerService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.userAgentString = web.settings.userAgentString + " ESP32Lab/4"   // activates the mobile UI (html.m)
        web.settings.domStorageEnabled = true        // projects.js keeps projects in localStorage
        web.settings.databaseEnabled = true
        web.settings.allowFileAccess = false
        web.settings.setSupportMultipleWindows(true)   // target=_blank -> onCreateWindow -> external browser
        web.settings.javaScriptCanOpenWindowsAutomatically = true
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean = openExternalIfNeeded(req.url)
            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = openExternalIfNeeded(Uri.parse(url))
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                // Capture the popup's URL with a throwaway WebView, then hand it to the system browser.
                val tmp = WebView(this@MainActivity)
                tmp.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean { openExternal(req.url); v.destroy(); return true }
                    override fun onPageStarted(v: WebView, url: String?, favicon: android.graphics.Bitmap?) { if (url != null && url != "about:blank") { openExternal(Uri.parse(url)); v.stopLoading(); v.destroy() } }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = tmp
                resultMsg.sendToTarget()
                return true
            }
        }
        web.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        setContentView(web)
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else waitAndLoad(0)
    }

    private var splash: android.widget.LinearLayout? = null
    private var bar: android.widget.ProgressBar? = null
    private var label: android.widget.TextView? = null
    private fun showSplash() {
        if (splash != null) return
        val l = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL; gravity = android.view.Gravity.CENTER; setPadding(64, 64, 64, 64); setBackgroundColor(0xFF101418.toInt()) }
        l.addView(android.widget.TextView(this).apply { text = "ESP32 Lab"; textSize = 28f; setTextColor(-1); gravity = android.view.Gravity.CENTER })
        l.addView(android.widget.TextView(this).apply { text = "First launch: installing the offline compiler and simulator (~300 MB). This happens once."; setTextColor(0xFFB0B8C0.toInt()); gravity = android.view.Gravity.CENTER; setPadding(0, 24, 0, 24) })
        bar = android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000 }
        l.addView(bar, android.widget.LinearLayout.LayoutParams(-1, -2))
        label = android.widget.TextView(this).apply { setTextColor(0xFFB0B8C0.toInt()); gravity = android.view.Gravity.CENTER; setPadding(0, 16, 0, 0) }
        l.addView(label)
        splash = l; setContentView(l)
    }
    private fun waitAndLoad(n: Int) {
        val port = ServerService.port
        if (port > 0 && AssetUnpacker.done) { if (splash != null) { splash = null; setContentView(web) }; web.loadUrl("http://127.0.0.1:$port/") }
        else if (AssetUnpacker.stage.startsWith("FAILED")) { showSplash(); label?.text = AssetUnpacker.stage + "\n" + ServerService.lastError }
        else if (port > 0 || n > 10) {
            showSplash(); bar?.progress = (AssetUnpacker.progress * 1000).toInt()
            label?.text = "${AssetUnpacker.stage}  ${(AssetUnpacker.progress * 100).toInt()}%"
            Handler(Looper.getMainLooper()).postDelayed({ waitAndLoad(n + 1) }, 200)
        }
        else if (n < 100000) Handler(Looper.getMainLooper()).postDelayed({ waitAndLoad(n + 1) }, 100)
        else web.loadData("<h3>Local server failed to start</h3><pre>${ServerService.lastError}</pre>", "text/html", "utf-8")
    }

    private fun isLocal(u: Uri): Boolean = u.host == "127.0.0.1" || u.host == "localhost"
    private fun openExternalIfNeeded(u: Uri): Boolean {
        val sch = u.scheme?.lowercase() ?: return false
        if ((sch == "http" || sch == "https") && isLocal(u)) return false
        if (sch == "about" || sch == "data" || sch == "blob" || sch == "javascript") return false
        openExternal(u); return true
    }
    private fun openExternal(u: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (e: Exception) { android.widget.Toast.makeText(this, "No app to open $u", android.widget.Toast.LENGTH_SHORT).show() }
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }
}
