package com.pulsedrop.transfer

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var discoveryRequested = false
  private var foreground = false
  private var discoveryLock: WifiManager.MulticastLock? = null

  fun setDiscoveryActive(active: Boolean) {
    runOnUiThread {
      discoveryRequested = active
      updateDiscoveryLock()
    }
  }

  override fun onResume() {
    super.onResume()
    foreground = true
    updateDiscoveryLock()
  }

  override fun onPause() {
    foreground = false
    updateDiscoveryLock()
    super.onPause()
  }

  private fun updateDiscoveryLock() {
    if (discoveryRequested && foreground) {
      if (discoveryLock == null) {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        discoveryLock = wifi?.createMulticastLock("PulseDrop:LANDiscovery")?.apply {
          setReferenceCounted(false)
        }
      }
      discoveryLock?.let { if (!it.isHeld) it.acquire() }
    } else {
      discoveryLock?.let { if (it.isHeld) it.release() }
    }
  }

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
    discoveryRequested = false
    foreground = false
    updateDiscoveryLock()
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
