package com.pulsedrop.transfer

import android.webkit.JavascriptInterface
import android.os.Build

class PulseDropAndroidBridge(private val activity: MainActivity) {
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
