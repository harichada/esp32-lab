package android.content
import java.io.File
class ApplicationInfo(@JvmField val nativeLibraryDir: String)
open class Context(val filesDir: File, val cacheDir: File, val applicationInfo: ApplicationInfo, val assets: android.content.res.AssetManager)
