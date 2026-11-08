package com.pulsedrop.transfer

import android.webkit.JavascriptInterface
import android.os.Build

class PulseDropAndroidBridge(private val activity: MainActivity) {
  @JavascriptInterface fun hotspotStatus(): String = activity.hotspot.status()
  @JavascriptInterface fun hotspotStart() { activity.hotspot.start() }
  @JavascriptInterface fun hotspotStop() { activity.hotspot.stop() }
  @JavascriptInterface fun hotspotJoin(ssid: String, password: String, bssid: String) { activity.hotspot.join(ssid, password, bssid) }
  @JavascriptInterface fun hotspotScan() { activity.hotspot.scan() }
  @JavascriptInterface fun hotspotScanStatus(): String = activity.hotspot.scanStatus()
  @JavascriptInterface fun hotspotScanStop() { activity.hotspot.stopScan() }
  @JavascriptInterface fun openWifiSettings(hosting: Boolean) { activity.hotspot.openSettings(hosting) }

  @JavascriptInterface
  fun setDiscoveryActive(active: Boolean) {
    activity.setDiscoveryActive(active)
  }

  @JavascriptInterface
  fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

  @JavascriptInterface
  fun openInbox() {
    activity.runOnUiThread {
      PulseDropStorageMirror.openInbox(activity)
    }
  }
}
