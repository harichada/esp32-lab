package com.hari.esp32lab

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/** Kotlin port of sim-site/server/server.py: static site + /api/health, /api/compile, /api/projects*, WS /api/run/{bid}. */
class LabServer(private val ctx: Context, port: Int) : NanoWSD("127.0.0.1", port) {
    companion object {
        const val FQBN_DEFAULT = "esp32:esp32:esp32doit-devkit-v1"
        const val MAX_BODY = 200 * 1024
        const val COMPILE_TIMEOUT_S = 300L          // phones are slower than the box (server.py: 120)
        const val PROJ_MAX = 500
        val NAME_RE = Regex("[A-Za-z0-9_.-]+\\.(h|hpp|c|cpp|ino)")
        val DEF_RE = Regex("[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_.\"]*)?")
        val PID_RE = Regex("[A-Za-z0-9_-]{1,40}")
        val NET_RE = Regex("#include\\s*[<\"](WiFi|HTTPClient|WiFiUdp)\\.h")
        val runs = java.util.concurrent.ConcurrentHashMap<String, QemuSession>()
        const val MAX_RUNS = 2
    }
    private val compileLock = ReentrantLock()
    val fqbn = FQBN_DEFAULT
    val FQBNS = setOf("esp32:esp32:esp32", "esp32:esp32:esp32doit-devkit-v1")

    private fun json(o: Any, code: Response.Status = Response.Status.OK): Response =
        newFixedLengthResponse(code, "application/json", o.toString()).also { it.addHeader("Cache-Control", "no-store") }

    override fun serveHttp(s: IHTTPSession): Response {
        val uri = s.uri
        return try {
            when {
                uri == "/api/health" -> health()
                uri == "/api/compile" && s.method == Method.POST -> compile(JSONObject(body(s)))
                uri == "/api/compile/status" -> json(Toolchain.status())
                uri == "/api/compile/progress" -> json(Toolchain.progress())   // same shape as server.py (build-log streaming in the page)
                uri == "/api/diag" -> json(Toolchain.diag())
                uri == "/api/projects" -> projList()
                uri.startsWith("/api/projects/") -> project(s, uri.removePrefix("/api/projects/"))
                uri.startsWith("/api/") -> json(JSONObject().put("error", "not found"), Response.Status.NOT_FOUND)
                else -> static(uri)
            }
        } catch (e: TooLarge) { json(JSONObject().put("ok", false).put("log", "request too large"), Response.Status.lookup(413) ?: Response.Status.BAD_REQUEST)
        } catch (e: Exception) { json(JSONObject().put("ok", false).put("log", "server error: $e"), Response.Status.INTERNAL_ERROR) }
    }
    class TooLarge : Exception()
    private fun body(s: IHTTPSession): String {
        val n = (s.headers["content-length"] ?: "0").toIntOrNull() ?: 0
        if (n > MAX_BODY) throw TooLarge()
        val buf = ByteArray(n); var off = 0
        while (off < n) { val r = s.inputStream.read(buf, off, n - off); if (r < 0) break; off += r }
        return String(buf, 0, off, Charsets.UTF_8)
    }

    // ---------------- static assets (assets/site) ----------------
    private fun static(uri0: String): Response {
        var uri = uri0.trimStart('/'); if (uri.isEmpty() || uri.endsWith("/")) uri += "index.html"
        if (uri.contains("..")) return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "forbidden")
        return try {
            val st = ctx.assets.open("site/$uri")
            newChunkedResponse(Response.Status.OK, mime(uri), st)
        } catch (e: IOException) { newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found") }
    }
    private fun mime(u: String) = when (u.substringAfterLast('.').lowercase()) {
        "html" -> "text/html; charset=utf-8"; "js", "mjs" -> "application/javascript"; "css" -> "text/css"
        "json" -> "application/json"; "png" -> "image/png"; "svg" -> "image/svg+xml"; "ico" -> "image/x-icon"
        "ino", "h", "cpp", "c", "txt", "md" -> "text/plain; charset=utf-8"; "wasm" -> "application/wasm"
        else -> NanoHTTPD.getMimeTypeForFile(u) ?: "application/octet-stream"
    }

    // ---------------- health ----------------
    private fun health(): Response {
        val q = Paths.qemu.exists() && Paths.romDir.isDirectory; val c = Paths.compiler.exists() && AssetUnpacker.done
        return json(JSONObject().put("ok", q && c).put("qemu", if (q) Paths.qemu.path else JSONObject.NULL)
            .put("arduino_cli", if (c) Paths.compiler.path else JSONObject.NULL).put("fqbn", fqbn).put("runs", runs.size)
            .put("platform", "android").put("fqbns", JSONArray(FQBNS.toList())).put("unpacked", AssetUnpacker.done).put("slirp", QemuSession.hasSlirp())
            .put("notes", "On-device backend (ESP32 Lab Android). Real Xtensa emulation via bundled Espressif QEMU (patched GPIO bridge)."))
    }

    // ---------------- compile ----------------
    private fun compile(req: JSONObject): Response {
        val sketch = req.optString("sketch", "")
        val fq = req.optString("fqbn", "").ifEmpty { fqbn }
        if (fq !in FQBNS) return json(JSONObject().put("ok", false).put("log", "unsupported board $fq (supported: ${FQBNS.joinToString()})"), Response.Status.BAD_REQUEST)
        if (!AssetUnpacker.done) return json(JSONObject().put("ok", false).put("unpacking", true).put("log", "Toolchain still unpacking: ${AssetUnpacker.stage} (${(AssetUnpacker.progress * 100).toInt()}%). Retry when it finishes."))
        val fo = req.optJSONObject("files") ?: JSONObject()
        val files = sortedMapOf<String, String>()
        for (k in fo.keys()) { val v = fo.opt(k); if (v !is String) return json(JSONObject().put("ok", false).put("log", "bad request"), Response.Status.BAD_REQUEST)
            if (NAME_RE.matches(k) && k != "sketch.ino") files[k] = v }
        if (sketch.length + files.values.sumOf { it.length } > MAX_BODY) return json(JSONObject().put("ok", false).put("log", "sources too large"), Response.Status.BAD_REQUEST)
        val defines = mutableListOf<String>(); req.optJSONArray("defines")?.let { for (i in 0 until it.length()) { val d = it.optString(i); if (DEF_RE.matches(d)) defines += d } }
        val all = sketch + files.values.joinToString("")
        val net = req.optBoolean("netShim", false) || NET_RE.containsMatchIn(all)
        val netmode = if (!net) null else if (req.optString("net") in listOf("lwip", "shim")) req.optString("net") else "lwip"
        val key = sha(JSONArray(listOf(sketch, JSONObject(files as Map<*, *>).toString(), defines.joinToString(","), net, netmode ?: "", fq, Toolchain.version())).toString()).substring(0, 16)
        val bdir = File(Paths.builds, key); val img = File(bdir, "flash.bin")
        fun res(ok: Boolean, log: String, cached: Boolean = false) = JSONObject().put("ok", ok).put("log", log).put("netShim", net).put("net", netmode ?: JSONObject.NULL)
            .apply { if (ok) put("id", key).put("cached", cached) }
        if (img.exists()) return json(res(true, File(bdir, "log.txt").takeIf { it.exists() }?.readText() ?: "", true))
        if (!compileLock.tryLock()) return json(JSONObject().put("ok", false).put("log", "another compile is running, retry shortly"), Response.Status.lookup(429) ?: Response.Status.BAD_REQUEST)
        try {
            val st = Toolchain.selftestOnce()
            if (!st.ok) return json(res(false, "On-device toolchain self-test failed (see /api/diag):\n" + st.log))
            val r = try { Toolchain.compile(bdir, sketch, files, defines, netmode, fq, COMPILE_TIMEOUT_S) }
                    catch (e: Throwable) { Toolchain.Result(false, "compile crashed:\n" + android.util.Log.getStackTraceString(e) + "\n--- partial log ---\n" + Toolchain.live) }
            File(bdir, "log.txt").writeText(r.log)
            if (!r.ok) return json(res(false, r.log))
            File(bdir, "net.txt").writeText(netmode ?: "")
            return json(res(true, r.log))
        } finally { compileLock.unlock() }
    }
    private fun sha(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    // ---------------- projects (filesDir/projects/<id>.json) ----------------
    private fun projList(): Response {
        val a = JSONArray(); val d = Paths.projects
        d.listFiles { f -> f.name.endsWith(".json") && !f.name.startsWith(".") }?.sortedByDescending { it.lastModified() }?.take(PROJ_MAX)?.forEach { f ->
            try { a.put(JSONObject().put("id", f.nameWithoutExtension).put("name", JSONObject(f.readText()).optString("name", f.nameWithoutExtension)).put("updated", f.lastModified())) } catch (_: Exception) {}
        }
        return json(a)
    }
    private fun project(s: IHTTPSession, raw: String): Response {
        val id = java.net.URLDecoder.decode(raw, "UTF-8").takeIf { PID_RE.matches(it) }
        val f = id?.let { File(Paths.projects, "$it.json") }
        return when (s.method) {
            Method.GET -> if (f == null || !f.exists()) json(JSONObject().put("error", "not found"), Response.Status.NOT_FOUND)
                          else newFixedLengthResponse(Response.Status.OK, "application/json", f.readText())
            Method.PUT -> {
                if (f == null) return json(JSONObject().put("error", "bad id"), Response.Status.BAD_REQUEST)
                val o = try { JSONObject(body(s)).also { it.getJSONArray("parts") } } catch (e: TooLarge) { throw e } catch (e: Exception) { return json(JSONObject().put("error", "not a project"), Response.Status.BAD_REQUEST) }
                Paths.projects.mkdirs()
                if (!f.exists() && (Paths.projects.list()?.count { it.endsWith(".json") } ?: 0) >= PROJ_MAX) return json(JSONObject().put("error", "project limit"), Response.Status.BAD_REQUEST)
                val tmp = File(Paths.projects, ".$id.tmp"); tmp.writeText(o.toString()); tmp.renameTo(f)
                json(JSONObject().put("ok", true).put("id", id))
            }
            Method.DELETE -> { f?.delete(); json(JSONObject().put("ok", true)) }
            else -> json(JSONObject().put("error", "method"), Response.Status.METHOD_NOT_ALLOWED)
        }
    }

    // ---------------- WS /api/run/{bid} ----------------
    override fun openWebSocket(h: IHTTPSession): WebSocket {
        val bid = h.uri.removePrefix("/api/run/").replace(Regex("[^0-9a-f]"), "")
        return RunSocket(h, bid, File(File(Paths.builds, bid), "flash.bin"))
    }
}

object Toolchain {
    data class Result(val ok: Boolean, val log: String)
    @Volatile var running = false; @Volatile var step = ""; @Volatile var t0 = 0L
    val live = StringBuffer()
    @Volatile private var selftest: Result? = null
    fun status(): JSONObject = JSONObject().put("running", running).put("step", step)
        .put("elapsed", if (running) (System.currentTimeMillis() - t0) / 1000.0 else 0.0)
        .put("log", live.toString().takeLast(16000)).put("unpacking", !AssetUnpacker.done)
        .put("unpackStage", AssetUnpacker.stage).put("unpackProgress", AssetUnpacker.progress)

    fun progress(): JSONObject = JSONObject().put("active", running)
        .put("elapsed", if (running) Math.round((System.currentTimeMillis() - t0) / 100.0) / 10.0 else 0.0)
        .put("log", if (running) live.toString().takeLast(20000) else "")
        .put("unpacking", !AssetUnpacker.done).put("unpackProgress", AssetUnpacker.progress)

    /** Run `libesp32compile.so --selftest` (each binary --version with 5 s timeout + a tiny gcc -c). */
    fun runSelftest(timeoutS: Long = 60): Result {
        val exe = Paths.compiler
        if (!exe.exists()) return Result(false, "missing ${exe.path}")
        return try {
            val pb = ProcessBuilder(exe.path, "--selftest", "--home", Paths.toolchainHome.path).directory(Paths.tmp).redirectErrorStream(true)
            pb.environment().apply { put("ESP32LAB_HOME", Paths.toolchainHome.path); put("ESP32LAB_BIN", Paths.nativeDir.path); put("TMPDIR", Paths.tmp.path); remove("LD_LIBRARY_PATH") }
            val p = pb.start(); val sb = StringBuffer()
            val rd = Thread { try { p.inputStream.bufferedReader().forEachLine { sb.append(it).append('\n') } } catch (_: Exception) {} }.apply { start() }
            if (!p.waitFor(timeoutS, TimeUnit.SECONDS)) { p.destroyForcibly(); rd.join(1000); return Result(false, sb.toString() + "\nselftest timed out after ${timeoutS}s") }
            rd.join(2000); Result(p.exitValue() == 0, sb.toString() + "\nexit=${p.exitValue()}")
        } catch (e: Throwable) { Result(false, "cannot start ${exe.path}:\n" + android.util.Log.getStackTraceString(e)) }
    }
    fun selftestOnce(): Result { selftest?.let { if (it.ok) return it }; return runSelftest().also { selftest = it } }
    fun diag(): JSONObject {
        val libs = JSONArray(); Paths.nativeDir.listFiles()?.sortedBy { it.name }?.forEach { libs.put(JSONObject().put("name", it.name).put("size", it.length()).put("exec", it.canExecute())) }
        val r = runSelftest(); selftest = r
        return JSONObject().put("ok", r.ok).put("selftest", r.log).put("nativeDir", Paths.nativeDir.path).put("libs", libs)
            .put("toolchainHome", Paths.toolchainHome.path).put("toolchainVersion", version()).put("compileSh", File(Paths.toolchainHome, "compile.sh").exists())
            .put("unpacked", AssetUnpacker.done).put("unpackStage", AssetUnpacker.stage)
            .put("sdk", android.os.Build.VERSION.SDK_INT).put("abi", android.os.Build.SUPPORTED_ABIS.joinToString())
    }
    fun version(): String = File(Paths.toolchainHome, "VERSION").takeIf { it.exists() }?.readText()?.trim() ?: (if (Paths.compiler.exists()) "present" else "stub")

    /** Contract (INTEGRATION.md §2): libesp32compile.so --fqbn F --sketch DIR --out DIR --home TOOLCHAIN_HOME
     *  [--define D]... [--net lwip|shim]; exit 0 and leave out/flash.bin (or out/<x>.ino.merged.bin). */
    fun compile(bdir: File, sketch: String, files: Map<String, String>, defines: List<String>, netmode: String?, fqbn: String, timeoutS: Long): Result {
        val sk = File(bdir, "sketch"); val out = File(bdir, "out")
        sk.deleteRecursively(); sk.mkdirs(); out.mkdirs()
        File(sk, "sketch.ino").writeText(sketch); files.forEach { (n, c) -> File(sk, n).writeText(c) }
        val exe = Paths.compiler
        if (!exe.exists()) return Result(false, "on-device compiler missing (${exe.name} not in nativeLibraryDir)\n")
        val cmd = mutableListOf(exe.path, "--fqbn", fqbn, "--sketch", sk.path, "--out", out.path, "--home", Paths.toolchainHome.path)
        defines.forEach { cmd += listOf("--define", it) }
        if (netmode != null) cmd += listOf("--net", netmode)
        val t0 = System.currentTimeMillis()
        val pb = ProcessBuilder(cmd).directory(bdir).redirectErrorStream(true)
        pb.environment().apply { put("ESP32LAB_HOME", Paths.toolchainHome.path); put("ESP32LAB_BIN", Paths.nativeDir.path); put("TMPDIR", Paths.tmp.path) }
        pb.environment().remove("LD_LIBRARY_PATH")
        live.setLength(0); step = "starting compiler"; Toolchain.t0 = t0Now(); running = true
        try {
        val p = try { pb.start() } catch (e: Throwable) { return Result(false, "cannot start ${exe.path}:\n" + android.util.Log.getStackTraceString(e)) }
        val sb = live; val rd = Thread { try { p.inputStream.bufferedReader().forEachLine { sb.append(it).append('\n'); if (it.startsWith("== ") || it.startsWith("-- ")) step = it.drop(3) } } catch (_: Exception) {} }.apply { start() }
        if (!p.waitFor(timeoutS, TimeUnit.SECONDS)) { p.destroyForcibly(); rd.join(1000); val l = sb.toString(); bdir.deleteRecursively(); return Result(false, l + "\ncompile timed out (${timeoutS}s) during: $step") }
        rd.join(2000)
        var log = sb.toString().replace(sk.path + "/", "").replace(Paths.files.path, "~")
        log += "\n[%.1fs] compile on-device%s\n".format((System.currentTimeMillis() - t0) / 1000.0, if (netmode != null) " (+$netmode)" else "")
        if (p.exitValue() != 0) return Result(false, log)
        val merged = File(out, "flash.bin").takeIf { it.exists() } ?: out.listFiles()?.firstOrNull { it.name.endsWith(".ino.merged.bin") }
            ?: return Result(false, log + "no merged image produced\n")
        val dst = File(bdir, "flash.bin"); merged.copyTo(dst, true)
        val pad = 4L * 1024 * 1024 - dst.length()
        if (pad > 0) dst.appendBytes(ByteArray(pad.toInt()) { 0xff.toByte() })
        return Result(true, log)
        } finally { running = false; step = "" }
    }
    private fun t0Now() = System.currentTimeMillis()
}
