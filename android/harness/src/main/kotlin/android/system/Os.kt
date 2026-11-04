package android.system
object Os { @JvmStatic fun symlink(t: String, l: String) { java.nio.file.Files.createSymbolicLink(java.nio.file.Paths.get(l), java.nio.file.Paths.get(t)) } }
