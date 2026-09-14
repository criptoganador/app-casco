plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.appcasco"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.example.appcasco"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {

    // Librería LiveKit Android (incluye WebRTC y soporte SFU)
    implementation("io.livekit:livekit-android:2.11.1")

    implementation(libs.appcompat)
    implementation(libs.material)
    implementation(libs.activity)
    implementation(libs.constraintlayout)

    // Librería UVC moderna desde Maven Central
    implementation("org.uvccamera:lib:0.0.13")
    // Se elimina la dependencia de legacy-support-v4 ya que la nueva librería
    // y las versiones modernas de Android ya no suelen necesitarla explícitamente.

    testImplementation(libs.junit)
    androidTestImplementation(libs.ext.junit)
    androidTestImplementation(libs.espresso.core)
}