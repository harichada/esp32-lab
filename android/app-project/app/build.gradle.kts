plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.hari.esp32lab"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.hari.esp32lab"
        minSdk = 24; targetSdk = 34; versionCode = 6; versionName = "0.6"
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    // native executables must be extracted to nativeLibraryDir so they can be exec()'d
    packaging { jniLibs { useLegacyPackaging = true } }
    androidResources { noCompress += listOf("tar", "bin", "zst", "gz", "tgz", "a") }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("org.nanohttpd:nanohttpd-websocket:2.3.1")
}
