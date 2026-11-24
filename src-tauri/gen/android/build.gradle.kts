buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        maven {
            // Resolve Maven Central dependencies through the mirror first to avoid CI rate limits.
            name = "GoogleMavenCentralMirror"
            url = uri("https://maven-central.storage-download.googleapis.com/maven2/")
        }
        mavenCentral()
    }

    configurations.configureEach {
        resolutionStrategy.force(
            "androidx.emoji2:emoji2:1.3.0",
            "androidx.emoji2:emoji2-views-helper:1.3.0",
            "androidx.lifecycle:lifecycle-process:2.10.0",
            "androidx.concurrent:concurrent-futures:1.1.0",
        )
    }
}

tasks.register("clean").configure {
    delete("build")
}

