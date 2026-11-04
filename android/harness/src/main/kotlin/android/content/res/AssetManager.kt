package android.content.res
import java.io.File
class AssetFileDescriptor(val length: Long) : AutoCloseable { override fun close() {} }
class AssetManager(private val root: File) {
    fun open(p: String) = File(root, p).inputStream()
    fun list(p: String): Array<String> = File(root, p).list()?.sorted()?.toTypedArray() ?: emptyArray()
    fun openFd(p: String) = AssetFileDescriptor(File(root, p).length())
}
