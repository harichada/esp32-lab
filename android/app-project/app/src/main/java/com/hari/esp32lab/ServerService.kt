package com.hari.esp32lab

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/** Foreground service hosting the embedded HTTP/WebSocket backend (port of server/server.py). */
class ServerService : Service() {
    companion object {
        @Volatile var port = 0
        @Volatile var lastError = ""
        const val PREFERRED_PORT = 8765
        private var server: LabServer? = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val ch = "esp32lab"
        if (Build.VERSION.SDK_INT >= 26)
            getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(ch, "ESP32 Lab backend", NotificationManager.IMPORTANCE_LOW))
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, ch) else Notification.Builder(this)
        val n = b.setContentTitle("ESP32 Lab").setContentText("Local compiler/simulator running")
            .setSmallIcon(android.R.drawable.ic_media_play).setContentIntent(pi).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(1, n)
        Thread {
            try {
                Paths.init(this)
                for (p in listOf(PREFERRED_PORT, 0)) {
                    try { val s = LabServer(this, p); s.start(0, false); server = s; port = s.listeningPort; break }
                    catch (e: Exception) { lastError = e.toString() }
                }
                Log.i("ESP32Lab", "server on 127.0.0.1:$port")
                AssetUnpacker.unpackIfNeeded(this)
            } catch (e: Throwable) { lastError = Log.getStackTraceString(e); AssetUnpacker.stage = "FAILED: $e"; Log.e("ESP32Lab", lastError) }
        }.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY

    override fun onDestroy() { server?.stop(); server = null; port = 0; super.onDestroy() }
}
