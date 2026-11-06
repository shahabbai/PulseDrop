# Keep the JavaScript bridge callable in minified release APKs.
-keepclassmembers class com.pulsedrop.transfer.PulseDropAndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations
