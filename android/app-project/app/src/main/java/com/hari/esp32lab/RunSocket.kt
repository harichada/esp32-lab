package com.hari.esp32lab

import android.util.Log
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/** One WebSocket <-> one QemuSession. Same message protocol as server.py (t: session/status/uart/gpio/mux/rtc/fsel/rmt/
 *  pwm/i2c/spi/adcq/reset/netlog/hb/exit/error; browser -> in/inv/gcache/i2cr/spir/spicfg/adc/uart/sync/netlog/stop). */
class RunSocket(h: NanoHTTPD.IHTTPSession, private val bid: String, private val img: File) : NanoWSD.WebSocket(h) {
    private var sess: QemuSession? = null
    private var n = 0
    @Synchronized fun sendJson(m: JSONObject) {
        n++; m.put("_n", n)
        try { if (isOpen) send(m.toString()) } catch (_: IOException) {}
    }
    override fun onOpen() {
        val params = handshakeRequest.parameters
        if (params["sid"]?.firstOrNull() != null) {   // server.py resumes detached sessions; on-device the WebView never tunnels, so no resume
            sendJson(JSONObject().put("t", "error").put("msg", "run session expired (QEMU was stopped)").put("expired", 1)); closeQuiet(); return
        }
        if (!img.exists()) { sendJson(JSONObject().put("t", "error").put("msg", "unknown build id")); closeQuiet(); return }
        if (LabServer.runs.size >= LabServer.MAX_RUNS) { sendJson(JSONObject().put("t", "error").put("msg", "too many concurrent runs")); closeQuiet(); return }
        val sid = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16)
        sendJson(JSONObject().put("t", "session").put("sid", sid).put("grace_s", 0).put("cap_s", 0))
        val s = QemuSession(sid, img, this); sess = s; LabServer.runs[sid] = s
        Thread({ try { s.run() } catch (e: Throwable) { Log.e("ESP32Lab", "session", e); sendJson(JSONObject().put("t", "error").put("msg", "session error: $e")) }
                 finally { LabServer.runs.remove(sid); closeQuiet() } }, "qemu-$sid").start()
    }
    private fun closeQuiet() { try { close(NanoWSD.WebSocketFrame.CloseCode.NormalClosure, "", false) } catch (_: Exception) {} }
    override fun onMessage(f: NanoWSD.WebSocketFrame) { try { sess?.onBrowser(JSONObject(f.textPayload)) } catch (e: Exception) { Log.w("ESP32Lab", "ws msg", e) } }
    override fun onClose(c: NanoWSD.WebSocketFrame.CloseCode?, r: String?, remote: Boolean) { sess?.stop("ws closed") }
    override fun onPong(p: NanoWSD.WebSocketFrame?) {}
    override fun onException(e: IOException?) { sess?.stop("ws error") }
}

class QemuSession(val sid: String, private val img: File, private val ws: RunSocket) {
    companion object {
        /** slirp support is detected once by asking the binary itself, so swapping in a slirp build needs only a rebuild. */
        @Volatile private var slirp: Boolean? = null
        fun hasSlirp(): Boolean = slirp ?: try {
            val p = ProcessBuilder(Paths.qemu.path, "-netdev", "help").redirectErrorStream(true).apply { environment()["TMPDIR"] = Paths.tmp.path }.start()
            val o = p.inputStream.bufferedReader().readText(); p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            Regex("^user$", RegexOption.MULTILINE).containsMatchIn(o)
        } catch (e: Exception) { false }.also { slirp = it }
    }
    @Volatile private var stopped = false
    private var proc: Process? = null
    private var gpioOut: java.io.OutputStream? = null
    private var uartOut: java.io.OutputStream? = null
    private val t0 = System.nanoTime()
    private fun ts() = (System.nanoTime() - t0) / 1e9
    private val gcOn = true
    // GPIO answer cache (server.py GPIO_CACHE)
    private val lock = Object()
    private var cacheOn = gcOn; private val cache = HashMap<String, Pair<Long, Int>>(); private var ep = 0; private var muxver = 0
    private var lastS: String? = null; private var seq = 0; private val pend = HashMap<Int, Pair<String, Int>>(); private var out: Int? = null
    private var netlogOn = true
    // I2C fast path (server.py I2C_FAST): page opts in with {t:'i2cfast'}; consecutive J W bytes go out as one message and a
    // start to an address the page already answered is ACKed here (cache cleared on 'inv'). lastI = inputs QEMU last got.
    private var i2cFast = false; private val i2cAck = HashMap<String, Int>(); private var i2cPend: Pair<String, Int>? = null
    private var lastI = 0L to 0; private var bwait = false
    private val httpSrvs = mutableListOf<ServerSocket>()
    private val pendingNet = java.util.concurrent.ConcurrentHashMap<Int, java.util.concurrent.CompletableFuture<Pair<Int, String>>>()
    private val nid = java.util.concurrent.atomic.AtomicInteger()

    /** Port of server.py http_handler(): one HTTP/1.x request per guest TCP connection, answered by the browser's mock devices. */
    private fun startHttpBridge(ss: ServerSocket, gport: Int) = Thread {
        while (!stopped) {
            val c = try { ss.accept() } catch (_: Exception) { break }
            Thread { c.use { sock ->
                try {
                    sock.soTimeout = 10000
                    val ins = java.io.BufferedInputStream(sock.getInputStream())
                    val head = StringBuilder()
                    while (!head.endsWith("\r\n\r\n")) { val b = ins.read(); if (b < 0) return@use; head.append(b.toChar()); if (head.length > 65536) return@use }
                    val lines = head.split("\r\n"); val rl = (lines[0].split(" ") + listOf("", "", "")); val method = rl[0]; val path = rl[1]
                    val hdrs = JSONObject(); var n = 0; var host = "host.sim.internal:$gport"
                    for (l in lines.drop(1)) { val i = l.indexOf(':'); if (i > 0) { val k = l.substring(0, i).trim(); val v = l.substring(i + 1).trim(); hdrs.put(k, v)
                        if (k.equals("content-length", true)) n = v.toIntOrNull() ?: 0; if (k.equals("host", true)) host = v } }
                    val body = ByteArray(n); var o = 0; while (o < n) { val r = ins.read(body, o, n - o); if (r < 0) break; o += r }
                    val t1 = System.currentTimeMillis(); nlog("http", "HTTP $method $host $path (guest TCP :$gport, $n B body)")
                    val id = nid.incrementAndGet(); val fut = java.util.concurrent.CompletableFuture<Pair<Int, String>>(); pendingNet[id] = fut
                    ws.sendJson(j("net").put("id", id).put("k", "http").put("via", "lwip").put("method", method).put("url", "http://$host$path").put("headers", hdrs).put("body", String(body, Charsets.ISO_8859_1)))
                    val (code, rb) = try { fut.get(10, java.util.concurrent.TimeUnit.SECONDS) } catch (e: Exception) { pendingNet.remove(id); nlog("http", "HTTP $method $host$path -> no answer from browser devices in 10 s", false); return@use }
                    val ms = System.currentTimeMillis() - t1
                    nlog("http", "HTTP $method $host$path -> " + if (code > 0) "$code (${rb.length} B, $ms ms)" else "no virtual device at this address -> connection closed ($ms ms)", code in 1..399)
                    if (code > 0) { val b = rb.toByteArray(Charsets.ISO_8859_1)
                        sock.getOutputStream().apply { write(("HTTP/1.1 $code ${if (code == 200) "OK" else "Error"}\r\nContent-Type: application/json\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n").toByteArray() + b); flush() } }
                } catch (e: Exception) { Log.w("ESP32Lab", "http bridge", e) }
            } }.start()
        }
    }.apply { isDaemon = true; start() }

    private fun gw(line: String) { synchronized(lock) { try { gpioOut?.write(line.toByteArray()); gpioOut?.flush() } catch (_: IOException) {} } }
    private fun j(t: String) = JSONObject().put("t", t)
    private fun nlog(k: String, msg: String, ok: Boolean = true) { if (netlogOn) ws.sendJson(j("netlog").put("ts", Math.round(ts() * 1000) / 1000.0).put("k", k).put("msg", msg).put("ok", ok)) }

    fun stop(why: String) { if (!stopped) { stopped = true; Log.i("ESP32Lab", "run $sid stop: $why"); proc?.destroy() } }

    fun run() {
        val qemu = Paths.qemu
        if (!qemu.exists()) { ws.sendJson(j("error").put("msg", "QEMU missing (${qemu.name} not in nativeLibraryDir)")); return }
        val tmp = File(Paths.runs, sid).apply { mkdirs() }
        try {
            val flash = File(tmp, "flash.bin"); img.copyTo(flash, true)
            val eb = ByteArray(124); val v = 16 shl 8; for (i in 0..3) eb[16 + i] = (v shr (8 * i)).toByte(); val efuse = File(tmp, "efuse.bin"); efuse.writeBytes(eb)
            val netmode = File(img.parentFile, "net.txt").takeIf { it.exists() }?.readText()?.trim() ?: ""
            // chardevs: QEMU connects as TCP client to our loopback listeners (unix sockets in app dirs also work; TCP is simpler on Android)
            val lo = InetAddress.getByName("127.0.0.1")
            val gsrv = ServerSocket(0, 1, lo); val ssrv = ServerSocket(0, 1, lo)
            gsrv.soTimeout = 10000; ssrv.soTimeout = 10000
            // lwip: open_eth + slirp; the browser-side HTTP/UDP device bridge (guestfwd/frame tap) is not ported yet
            val nic = if (netmode == "lwip" && hasSlirp()) {
                // virtual devices at 10.0.2.100:{8080,8060,80}: slirp guestfwd -> our loopback listener -> browser ('net' / 'netr')
                val fw = listOf(8080, 8060, 80).map { gp -> val ss = ServerSocket(0, 8, lo); httpSrvs += ss; startHttpBridge(ss, gp); "guestfwd=tcp:10.0.2.100:$gp-tcp:127.0.0.1:${ss.localPort}" }
                listOf("-net", "nic,model=open_eth", "-net", "user," + fw.joinToString(","))
            } else listOf("-nic", "none")
            val args = mutableListOf(qemu.path, "-display", "none", "-machine", "esp32", "-drive", "file=${flash.path},if=mtd,format=raw") + nic + listOf(
                "-chardev", "socket,id=ser,host=127.0.0.1,port=${ssrv.localPort}", "-serial", "chardev:ser",
                "-chardev", "socket,id=gp,host=127.0.0.1,port=${gsrv.localPort}", "-global", "driver=esp32.gpio,property=chardev,value=gp",
                "-drive", "file=${efuse.path},if=none,format=raw,id=efuse", "-global", "driver=nvram.esp32.efuse,property=drive,value=efuse",
                "-L", Paths.romDir.path, "-monitor", "none", "-icount", "shift=4,align=off,sleep=on")
            val pb = ProcessBuilder(args).directory(tmp).redirectErrorStream(true)
            pb.environment()["TMPDIR"] = Paths.tmp.path
            val p = pb.start(); proc = p
            ws.sendJson(j("status").put("msg", "qemu started").put("cap_s", 0))
            nlog("wifi", "network: " + if (netmode == "lwip") (if (hasSlirp()) "open_eth NIC + slirp (DHCP 10.0.2.x, virtual devices at 10.0.2.100:80/8060/8080; LAN UDP tap not ported)" else "this QEMU build has no slirp: network disabled") else if (netmode.isNotEmpty()) "UART shim" else "no network library in this sketch")
            val qlog = StringBuilder()
            Thread { try { p.inputStream.bufferedReader().forEachLine { if (qlog.length < 8000) qlog.append(it).append('\n') } } catch (_: Exception) {} }.start()
            val g: Socket; val s: Socket
            try { g = gsrv.accept(); s = ssrv.accept() } catch (e: Exception) {
                Thread.sleep(300); ws.sendJson(j("error").put("msg", "qemu did not connect: $qlog")); p.destroy(); return
            } finally { gsrv.close(); ssrv.close() }
            g.tcpNoDelay = true; s.tcpNoDelay = true
            gpioOut = g.getOutputStream(); uartOut = s.getOutputStream()
            val tg = Thread { pumpGpio(g) }.apply { start() }
            val tu = Thread { pumpUart(s) }.apply { start() }
            val hb = Thread { try { while (!stopped) { Thread.sleep(4000); ws.sendJson(j("hb")) } } catch (_: InterruptedException) {} }.apply { start() }
            while (!stopped && p.isAlive) Thread.sleep(100)
            httpSrvs.forEach { try { it.close() } catch (_: Exception) {} }
            stopped = true; p.destroy(); hb.interrupt()
            try { g.close(); s.close() } catch (_: Exception) {}
            tg.join(1000); tu.join(1000)
            nlog("wifi", "session ended: link down")
            ws.sendJson(j("exit").put("code", try { p.exitValue() } catch (_: Exception) { JSONObject.NULL }))
        } finally { tmp.deleteRecursively() }
    }

    private fun pumpGpio(sock: Socket) {
        val rd = sock.getInputStream().bufferedReader(Charsets.ISO_8859_1)
        val spib = StringBuilder(); var spiBus = -1
        val i2cb = ArrayList<Long>()
        fun flushI2c() { if (i2cb.isNotEmpty()) { ws.sendJson(j("i2c").put("op", "W").put("a", JSONArray(i2cb))); i2cb.clear() } }
        fun flushSpi() { if (spib.isNotEmpty()) { ws.sendJson(j("spi").put("bus", spiBus).put("r", 0).put("hex", spib.toString())); spib.setLength(0) } }
        try {
            while (!stopped) {
                val line = rd.readLine() ?: break
                val p = line.trim().split(Regex("\\s+")); if (p.isEmpty() || p[0].isEmpty()) continue
                val ts = ts()
                if (p[0] == "U" && p.size > 3 && p[2] == "0") {
                    if (spib.isNotEmpty() && spiBus != p[1].toInt()) flushSpi()
                    spiBus = p[1].toInt(); spib.append(p[3])
                    if (spib.length < 64000 && rd.ready()) continue
                    flushSpi(); continue
                }
                if (p[0] == "J" && p.size > 2 && p[1] == "W" && i2cFast) {
                    i2cb.add(p[2].toLong()); if (i2cb.size < 4096 && rd.ready()) continue
                    flushI2c(); continue
                }
                flushI2c()
                flushSpi()
                when (p[0]) {
                    "U" -> ws.sendJson(j("spi").put("bus", p[1].toInt()).put("r", p[2].toInt()).put("hex", if (p.size > 3) p[3] else ""))
                    "S", "M", "R" -> {
                        val m: JSONObject
                        synchronized(lock) {
                            if (p[0] == "S") { lastS = p.subList(1, 5).joinToString(","); m = j("gpio").put("ts", ts).put("out", p[1].toLong()).put("out1", p[2].toLong()).put("en", p[3].toLong()).put("en1", p[4].toLong()) }
                            else { muxver++; m = j(if (p[0] == "M") "mux" else "rtc").put("ts", ts).put("off", p[1].toLong()).put("v", p[2].toLong()) }
                            seq++; val q = seq; m.put("q", q); val key = "$lastS|$muxver"
                            val hit = if (cacheOn) cache[key] else null
                            if (hit != null) { gpioOut?.write("I ${hit.first} ${hit.second}\n".toByteArray()); gpioOut?.flush(); lastI = hit; m.put("fast", 1); out = null }
                            else { pend[q] = key to ep; out = q; if (pend.size > 512) pend.clear() }
                        }
                        ws.sendJson(m)
                    }
                    "F" -> ws.sendJson(j("fsel").put("ts", ts).put("pin", p[1].toInt()).put("sig", p[2].toInt()))
                    "T" -> ws.sendJson(j("rmt").put("ts", ts).put("ch", p[1].toInt()).put("tick_ns", p[2].toLong()).put("car_hi", p[3].toLong()).put("car_lo", p[4].toLong()).put("car_en", p[5].toInt()).put("items", JSONArray(p.drop(6))))
                    "P" -> ws.sendJson(j("pwm").put("ts", ts).put("ch", p[1].toInt()).put("duty", p[2].toLong()).put("res", p[3].toInt()).put("div", p[4].toLong()))
                    "J" -> {
                        val m = j("i2c").put("op", p[1]).put("a", JSONArray(p.drop(2).map { it.toLong() }))
                        synchronized(lock) {
                            if (p[1] == "S" && i2cFast && p.size >= 4) {
                                val k = p[2] + "," + p[3]; val hit = i2cAck[k]
                                if (hit != null) { gw("K $hit\nI ${lastI.first} ${lastI.second}\n"); m.put("fast", 1); i2cPend = null }
                                else i2cPend = k to ep
                            }
                            if ((p[1] == "S" && !m.has("fast")) || p[1] == "R") bwait = true   // QEMU now blocks for K/B (+ I)
                        }
                        ws.sendJson(m)
                    }
                    "Q" -> { synchronized(lock) { bwait = true }; ws.sendJson(j("adcq").put("ts", ts).put("u", p[1].toInt()).put("ch", p[2].toInt())) }
                    "X" -> ws.sendJson(j("reset").put("ts", ts))
                }
            }
        } catch (_: IOException) {} catch (e: Exception) { Log.w("ESP32Lab", "gpio pump", e) }
        stop("gpio closed")
    }

    private fun pumpUart(sock: Socket) {
        val ins = sock.getInputStream(); val buf = ByteArray(4096); var ub = ""
        try {
            while (!stopped) {
                val r = ins.read(buf); if (r < 0) break
                val txt = String(buf, 0, r, Charsets.ISO_8859_1)
                ws.sendJson(j("uart").put("d", txt))
                if (netlogOn) {
                    ub += txt; val lines = ub.split('\n'); ub = lines.last().takeLast(2000)
                    for (ln0 in lines.dropLast(1)) { val ln = ln0.trim()
                        if (ln.startsWith("[qemu-eth]")) { val b = ln.substring(10).trim(); nlog(if (b.startsWith("DNS")) "dns" else if (b.startsWith("connect")) "tcp" else "wifi", b, !b.lowercase().contains("fail")) }
                        else if (ln.startsWith("[net]")) nlog("fw", ln.substring(5).trim(), !Regex("fail|error|-\\d+\\b|no reply|timeout", RegexOption.IGNORE_CASE).containsMatchIn(ln))
                    }
                }
            }
        } catch (_: IOException) {}
        stop("uart closed")
    }

    fun onBrowser(m: JSONObject) {
        when (m.optString("t")) {
            "in" -> synchronized(lock) {
                val v = (m.optLong("in", 0) and 0xffffffffL) to (m.optInt("in1", 0) and 0xff)
                if (m.has("q")) {
                    val q = m.optInt("q"); val pe = pend.remove(q)
                    if (pe != null && pe.second == ep && cacheOn) { if (cache.size > 4096) cache.clear(); cache[pe.first] = v }
                    if (out == q || !cacheOn) { out = null; lastI = v; gw("I ${v.first} ${v.second}\n") }
                } else {
                    ep++; cache.clear(); lastI = v
                    // QEMU blocked on a GPIO/pin-config request: its own (q) answer, computed later, carries this change too
                    if (out != null) return@synchronized
                    // see server.py: hold unsolicited inputs while QEMU waits for an I2C/ADC answer, and prefix "K 0" so a stale
                    // I line consumed by the next I2C start ACKs instead of silently NACKing (lost byte)
                    if (!bwait) gw("K 0\nI ${v.first} ${v.second}\n")
                }
            }
            "inv" -> { synchronized(lock) { ep++; cache.clear(); i2cAck.clear(); i2cPend = null }; ws.sendJson(j("invack")) }
            "i2cfast" -> synchronized(lock) { i2cFast = m.optBoolean("on", true); i2cAck.clear(); i2cPend = null }
            "gcache" -> synchronized(lock) { cacheOn = gcOn && m.optBoolean("on", true); cache.clear(); ep++ }
            "i2cr" -> synchronized(lock) {
                bwait = false
                val sb = StringBuilder()
                if (m.has("ack")) { sb.append("K ${m.optInt("ack")}\n"); val pe = i2cPend; i2cPend = null; if (pe != null && pe.second == ep && i2cFast) i2cAck[pe.first] = m.optInt("ack") }
                if (m.has("b")) sb.append("B ${m.optInt("b") and 0xff}\n")
                gw(sb.toString())
            }
            "spir" -> gw("V ${m.optString("hex").filter { it in "0123456789abcdefABCDEF" }.take(128)}\n")
            "spicfg" -> gw("Z ${m.optLong("mask", 0) and ((1L shl 40) - 1)}\n")
            "adc" -> synchronized(lock) { bwait = false; gw("A ${m.optInt("u")} ${m.optInt("ch")} ${m.optInt("v") and 0xffff}\n") }
            "uart" -> try { uartOut?.write(m.optString("d").toByteArray(Charsets.ISO_8859_1)); uartOut?.flush() } catch (_: IOException) {}
            "sync" -> gw(if (m.optBoolean("on")) "Y 1\n" else "Y 0\n")
            "netlog" -> netlogOn = m.optBoolean("on", true)
            "netr" -> pendingNet.remove(m.optInt("id"))?.complete(m.optInt("code", -1) to m.optString("body", ""))
            "udpr" -> {}   // UDP frame tap (LAN devices e.g. 10.13.37.2) not ported (see INTEGRATION.md)
            "stop" -> stop(m.optString("why", "user"))
        }
    }
}
