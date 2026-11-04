package com.hari.esp32lab

import android.content.Context
import android.util.Log
import java.io.File
import java.io.InputStream
import java.util.zip.GZIPInputStream

/** Copies assets/payload/<dir>/ (recursively) into filesDir/<dir>/ once per payload VERSION.
 *  X.tar / X.tar.gz assets are extracted in-process (pure Kotlin ustar/GNU/pax reader; no dependency on /system/bin/tar).
 *  Progress is published in [progress] (0..1) / [stage] for the activity's first-run screen. */
object AssetUnpacker {
    @Volatile var progress = 0.0
    @Volatile var stage = "starting"
    @Volatile var done = false
    private var total = 1L; private var doneBytes = 0L

    fun unpackIfNeeded(c: Context) {
        val am = c.assets
        val ver = try { am.open("payload/VERSION").bufferedReader().readText().trim() } catch (e: Exception) { done = true; return }
        val stamp = File(c.filesDir, ".payload-version")
        if (stamp.exists() && stamp.readText() == ver) { done = true; progress = 1.0; return }
        stamp.delete()
        val tops = (am.list("payload") ?: emptyArray()).filter { it != "VERSION" }
        total = tops.sumOf { size(c, "payload/$it") }.coerceAtLeast(1)
        for (top in tops) { val dst = File(c.filesDir, top); stage = "Removing old $top"; dst.deleteRecursively(); copy(c, "payload/$top", dst) }
        stamp.writeText(ver); progress = 1.0; stage = "done"; done = true
        Log.i("ESP32Lab", "payload $ver unpacked")
    }
    private fun size(c: Context, p: String): Long {
        val kids = c.assets.list(p) ?: emptyArray()
        if (kids.isNotEmpty()) return kids.sumOf { size(c, "$p/$it") }
        return try { c.assets.openFd(p).use { it.length } } catch (e: Exception) { c.assets.open(p).use { it.available().toLong() } }
    }
    private class Counting(val i: InputStream) : InputStream() {
        override fun read() = i.read().also { if (it >= 0) tick(1) }
        override fun read(b: ByteArray, o: Int, l: Int) = i.read(b, o, l).also { if (it > 0) tick(it.toLong()) }
        override fun close() = i.close()
    }
    private fun tick(n: Long) { doneBytes += n; progress = doneBytes.toDouble() / total }
    private fun copy(c: Context, path: String, dst: File) {
        val kids = c.assets.list(path) ?: emptyArray()
        if (kids.isNotEmpty()) { dst.mkdirs(); for (k in kids) copy(c, "$path/$k", File(dst, k)); return }
        dst.parentFile?.mkdirs()
        val raw = Counting(c.assets.open(path).buffered(1 shl 16))
        when {
            dst.name.endsWith(".tar.gz") || dst.name.endsWith(".tgz") -> { stage = "Unpacking ${dst.name}"; untar(GZIPInputStream(raw, 1 shl 16), dst.parentFile!!) }
            dst.name.endsWith(".tar") -> { stage = "Unpacking ${dst.name}"; untar(raw, dst.parentFile!!) }
            else -> { stage = "Copying ${dst.name}"; raw.use { i -> dst.outputStream().use { i.copyTo(it) } } }
        }
    }

    fun untar(ins0: InputStream, root: File) {
        val ins = ins0.buffered(1 shl 16); val hdr = ByteArray(512); val rootC = root.canonicalPath
        var longName: String? = null; var longLink: String? = null
        fun readFully(b: ByteArray, n: Int = b.size) { var o = 0; while (o < n) { val r = ins.read(b, o, n - o); if (r < 0) throw java.io.EOFException("truncated tar"); o += r } }
        fun str(o: Int, l: Int): String { var e = o; while (e < o + l && hdr[e] != 0.toByte()) e++; return String(hdr, o, e - o, Charsets.UTF_8) }
        fun oct(o: Int, l: Int): Long { val s = str(o, l).trim(); return if (s.isEmpty()) 0 else s.toLong(8) }
        fun data(sz: Long): ByteArray { val b = ByteArray(sz.toInt()); readFully(b); skipPad(ins, sz); return b }
        ins.use {
            while (true) {
                readFully(hdr)
                if (hdr.all { it == 0.toByte() }) break
                val type = hdr[156].toInt().toChar(); val sz = oct(124, 12); val mode = oct(100, 8)
                var name = str(0, 100); val prefix = if (str(257, 6).startsWith("ustar")) str(345, 155) else ""
                if (prefix.isNotEmpty()) name = "$prefix/$name"
                var link = str(157, 100)
                when (type) {
                    'L' -> { longName = String(data(sz), Charsets.UTF_8).trimEnd('\u0000'); continue }
                    'K' -> { longLink = String(data(sz), Charsets.UTF_8).trimEnd('\u0000'); continue }
                    'x' -> { val pax = String(data(sz), Charsets.UTF_8)
                             for (ln in pax.split('\n')) { val kv = ln.substringAfter(' ', ""); if (kv.startsWith("path=")) longName = kv.substring(5); if (kv.startsWith("linkpath=")) longLink = kv.substring(9) }
                             continue }
                    'g' -> { data(sz); continue }
                }
                longName?.let { name = it }; longLink?.let { link = it }; longName = null; longLink = null
                val f = File(root, name)
                if (!f.canonicalPath.startsWith(rootC) && !(type == '2')) throw SecurityException("tar path escapes: $name")
                when (type) {
                    '5' -> { f.mkdirs() }
                    '2' -> { f.parentFile?.mkdirs(); f.delete(); android.system.Os.symlink(link, f.path) }
                    '1' -> { f.parentFile?.mkdirs(); File(root, link).copyTo(f, true) }
                    '0', '\u0000', '7' -> {
                        f.parentFile?.mkdirs()
                        f.outputStream().buffered(1 shl 16).use { o -> var left = sz; val buf = ByteArray(1 shl 16)
                            while (left > 0) { val r = ins.read(buf, 0, minOf(buf.size.toLong(), left).toInt()); if (r < 0) throw java.io.EOFException(); o.write(buf, 0, r); left -= r } }
                        skipPad(ins, sz)
                        if (mode and 0b001_000_000 != 0L) f.setExecutable(true, false)
                    }
                    else -> { var left = sz + pad(sz); while (left > 0) { val s = ins.skip(left); if (s <= 0) { ins.read(); left-- } else left -= s } }
                }
            }
        }
    }
    private fun pad(sz: Long) = (512 - sz % 512) % 512
    private fun skipPad(i: InputStream, sz: Long) { var p = pad(sz); while (p > 0) { if (i.read() < 0) return; p-- } }
}
