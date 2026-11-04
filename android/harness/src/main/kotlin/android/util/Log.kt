package android.util
object Log {
    @JvmStatic fun i(t: String, m: String) = println("I/$t: $m").let { 0 }
    @JvmStatic fun w(t: String, m: String, e: Throwable? = null) = println("W/$t: $m ${e ?: ""}").let { 0 }
    @JvmStatic fun e(t: String, m: String, e: Throwable? = null) = println("E/$t: $m ${e ?: ""}").let { 0 }
    @JvmStatic fun getStackTraceString(e: Throwable) = e.stackTraceToString()
}
