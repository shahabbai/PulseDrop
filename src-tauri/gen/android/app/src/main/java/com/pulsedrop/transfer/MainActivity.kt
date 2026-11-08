package com.pulsedrop.transfer

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

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
    configureSystemBarInsets()
    requestLegacyWritePermission()
    PulseDropStorageMirror.start(this)
  }

  private fun configureSystemBarInsets() {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
    )

    // Pad the stable parent, not the generated WebView or a particular HTML header.
    // This also covers landscape cutouts, gesture navigation, and older WebViews.
    val content = window.decorView.findViewById<View>(android.R.id.content)
    content.setBackgroundColor(ContextCompat.getColor(this, R.color.pulsedrop_background))
    val baseLeft = content.paddingLeft
    val baseTop = content.paddingTop
    val baseRight = content.paddingRight
    val baseBottom = content.paddingBottom
    val handledTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val safe = windowInsets.getInsets(handledTypes)
      view.setPadding(baseLeft + safe.left, baseTop + safe.top, baseRight + safe.right, baseBottom + safe.bottom)

      // These insets are already applied. Zero them for the WebView to avoid
      // double spacing while still forwarding keyboard and future inset updates.
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handledTypes, Insets.NONE)
        .build()
    }
    content.post { ViewCompat.requestApplyInsets(content) }
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
