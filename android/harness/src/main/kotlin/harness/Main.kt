package harness
import android.content.*
import android.content.res.AssetManager
import com.hari.esp32lab.*
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.net.http.*

/** Runs the app's real LabServer/RunSocket/AssetUnpacker code on the JVM; aarch64 binaries run via binfmt qemu-aarch64. */
fun main(a: Array<String>) {
    if (a[2] == "serve") { val m = File(a[0]); val w = File(a[1]); val c = Context(File(w, "files").apply { mkdirs() }, File(w, "cache").apply { mkdirs() }, ApplicationInfo(File(m, "jniLibs/arm64-v8a").path), AssetManager(File(m, "assets")))
        Paths.init(c); AssetUnpacker.unpackIfNeeded(c); val s = LabServer(c, a[3].toInt()); s.start(0, false); println("SERVING ${s.listeningPort}"); Thread.sleep(Long.MAX_VALUE) }
    val main = File(a[0]); val work = File(a[1]); val sketch = File(a[2]).readText(); val secs = a.getOrElse(3) { "40" }.toLong()
    val ctx = Context(File(work, "files").apply { mkdirs() }, File(work, "cache").apply { mkdirs() }, ApplicationInfo(File(main, "jniLibs/arm64-v8a").path), AssetManager(File(main, "assets")))
    Paths.init(ctx)
    val t = System.currentTimeMillis(); AssetUnpacker.unpackIfNeeded(ctx); println("UNPACK done=${AssetUnpacker.done} in ${System.currentTimeMillis() - t} ms")
    val srv = LabServer(ctx, 0); srv.start(0, true); val port = srv.listeningPort; println("SERVER 127.0.0.1:$port")
    val hc = HttpClient.newHttpClient()
    fun get(p: String) = hc.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port$p")).build(), HttpResponse.BodyHandlers.ofString())
    println("HEALTH " + get("/api/health").body())
    println("INDEX " + get("/").statusCode() + " " + get("/js/app.js").body().length + "B app.js")
    val put = hc.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/projects/p1")).PUT(HttpRequest.BodyPublishers.ofString("""{"name":"t","parts":[]}""")).build(), HttpResponse.BodyHandlers.ofString())
    println("PROJ PUT ${put.body()} LIST ${get("/api/projects").body()} GET ${get("/api/projects/p1").body()}")
    val bad = hc.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/compile")).POST(HttpRequest.BodyPublishers.ofString(JSONObject().put("sketch", sketch).put("fqbn", "esp32:esp32:esp32s3").toString())).build(), HttpResponse.BodyHandlers.ofString())
    println("BADFQBN ${bad.statusCode()} ${bad.body()}")
    val t1 = System.currentTimeMillis()
    val r = hc.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/compile")).timeout(java.time.Duration.ofSeconds(600)).POST(HttpRequest.BodyPublishers.ofString(JSONObject().put("sketch", sketch).put("fqbn", System.getenv("FQBN") ?: "esp32:esp32:esp32doit-devkit-v1").toString())).build(), HttpResponse.BodyHandlers.ofString())
    val cj = JSONObject(r.body()); println("COMPILE ok=${cj.optBoolean("ok")} id=${cj.optString("id")} ${System.currentTimeMillis() - t1} ms\n--log tail--\n${cj.optString("log").takeLast(600)}")
    if (!cj.optBoolean("ok")) { srv.stop(); System.exit(1) }
    val outs = sortedSetOf<Long>(); val counts = sortedMapOf<String, Int>(); val uart = StringBuilder(); val done = java.util.concurrent.CountDownLatch(1)
    val ws = object : WebSocketClient(URI("ws://127.0.0.1:$port/api/run/${cj.getString("id")}")) {
        override fun onOpen(h: ServerHandshake) {}
        override fun onMessage(s: String) { val m = JSONObject(s); val ty = m.optString("t"); counts.merge(ty, 1, Int::plus); if (ty == "gpio") outs.add(m.optLong("out"))
            when (ty) { "uart" -> uart.append(m.optString("d")); "gpio", "mux", "rtc" -> if (m.has("q") && !m.has("fast")) send("""{"t":"in","q":${m.getInt("q")},"in":0,"in1":0}""")
                "status", "error", "session", "exit" -> println("WS $s"); "gpio" -> {} }
            if (counts.getOrDefault("gpio", 0) in 1..3 && ty == "gpio") println("WS GPIO $s")
            if (ty == "exit" || ty == "error") done.countDown() }
        override fun onClose(c: Int, r: String, remote: Boolean) { done.countDown() }
        override fun onError(e: Exception) { println("WSERR $e") }
    }
    ws.connectBlocking(); done.await(secs, java.util.concurrent.TimeUnit.SECONDS)
    ws.send("""{"t":"stop"}"""); Thread.sleep(1500)
    println("WS COUNTS $counts"); println("GPIO out values seen: $outs (bit2 = LED on GPIO2)"); println("--uart--\n" + uart.toString().takeLast(1500))
    ws.close(); srv.stop(); System.exit(0)
}
