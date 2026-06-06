package com.pulsedrop.transfer

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestLegacyWritePermission()
    PulseDropStorageMirror.start(this)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(PulseDropAndroidBridge(this), "PulseDropAndroid")
  }

  override fun onDestroy() {
    PulseDropStorageMirror.stop()
    super.onDestroy()
  }

  private fun requestLegacyWritePermission() {
    if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) return

    val permission = Manifest.permission.WRITE_EXTERNAL_STORAGE
    if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(permission), 53612)
    }
  }
}