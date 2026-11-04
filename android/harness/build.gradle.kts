plugins { kotlin("jvm") version "1.9.24"; application }
kotlin { jvmToolchain(17) }
val app = "../app-project/app/src/main/java/com/hari/esp32lab"
sourceSets["main"].kotlin.srcDirs("src/main/kotlin")
sourceSets["main"].kotlin.srcDir(layout.buildDirectory.dir("appsrc"))
val copyApp by tasks.registering(Copy::class) {
    from(app) { include("LabServer.kt", "RunSocket.kt", "AssetUnpacker.kt", "Paths.kt") }
    into(layout.buildDirectory.dir("appsrc"))
}
tasks.named("compileKotlin") { dependsOn(copyApp) }
dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1"); implementation("org.nanohttpd:nanohttpd-websocket:2.3.1")
    implementation("org.json:json:20240303")
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
}
application { mainClass.set("harness.MainKt") }
