package com.pulsedrop.transfer

import android.webkit.JavascriptInterface

class PulseDropAndroidBridge(private val activity: MainActivity) {
  @JavascriptInterface
  fun openInbox() {
    activity.runOnUiThread {
      PulseDropStorageMirror.openInbox(activity)
    }
  }
}