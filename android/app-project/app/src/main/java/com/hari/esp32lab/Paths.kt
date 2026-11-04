package com.hari.esp32lab

import android.content.Context
import java.io.File

/** Single source of truth for every on-device path the other agents' artifacts plug into (see INTEGRATION.md). */
object Paths {
    lateinit var nativeDir: File; lateinit var files: File; lateinit var cache: File
    fun init(c: Context) { nativeDir = File(c.applicationInfo.nativeLibraryDir); files = c.filesDir; cache = c.cacheDir }
    // jniLibs/arm64-v8a/*.so -> exec'd from nativeLibraryDir
    val compiler get() = File(nativeDir, "libesp32compile.so")
    val qemu get() = File(nativeDir, "libqemu-system-xtensa.so")
    // assets/payload/<name>/... -> unpacked to filesDir/<name>/ on first run (or when assets/payload/VERSION changes)
    val toolchainHome get() = File(files, "toolchain")
    val romDir get() = File(files, "qemu-rom")
    val builds get() = File(files, "builds").apply { mkdirs() }
    val projects get() = File(files, "projects")
    val tmp get() = File(cache, "tmp").apply { mkdirs() }
    val runs get() = File(files, "runs").apply { mkdirs() }
}
