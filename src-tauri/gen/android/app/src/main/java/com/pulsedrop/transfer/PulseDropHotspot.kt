package com.pulsedrop.transfer

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.MacAddress
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import org.json.JSONArray
import java.net.Inet4Address
import java.net.NetworkInterface

/** All state transitions/callbacks run on main; JS reads an immutable snapshot. */
class PulseDropHotspot(private val activity: MainActivity) {
  private val handler = Handler(Looper.getMainLooper())
  private val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
  private val connectivity = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private var generation = 0
  private var reservation: AutoCloseable? = null
  private var callback: ConnectivityManager.NetworkCallback? = null
  private var bound = false
  private var permissionAction: (() -> Unit)? = null
  private var permissionGeneration = 0
  private var scanGeneration = 0
  private var scanReceiver: BroadcastReceiver? = null
  private var scanPermissionAction: (() -> Unit)? = null
  @Volatile private var scanSnapshot = JSONObject().put("state", "idle").toString()
  @Volatile private var snapshot = json("idle")

  private fun json(mode: String, ssid: String = "", password: String = "", address: String? = null, error: String = ""): String =
    JSONObject().put("mode", mode).put("ssid", ssid).put("password", password)
      .put("address", address ?: JSONObject.NULL).put("error", error)
      .put("can_scan", wifi != null)
      .put("can_host", wifi != null && Build.VERSION.SDK_INT >= 26).put("can_join", wifi != null && Build.VERSION.SDK_INT >= 29).toString()

  fun status(): String = snapshot
  private fun fail(message: String) { snapshot = json("error", error = message) }

  private fun withPermission(action: () -> Unit) {
    val permission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION
    if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) { action(); return }
    permissionAction = action
    permissionGeneration = generation
    val permissions = if (Build.VERSION.SDK_INT >= 33) arrayOf(permission) else arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, permission)
    ActivityCompat.requestPermissions(activity, permissions, PERMISSION_REQUEST)
  }

  fun onPermissionsResult(requestCode: Int, grantResults: IntArray) {
    if (requestCode == SCAN_PERMISSION_REQUEST) {
      val action = scanPermissionAction; scanPermissionAction = null
      if (action == null) return
      // Android can grant coarse-only; scans require precise Location.
      if (ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) action()
      else scanFail("To list nearby Wi-Fi, allow precise Location for PulseDrop. You can scan a QR instead without Location access.")
      return
    }
    if (requestCode != PERMISSION_REQUEST) return
    val action = permissionAction; permissionAction = null
    if (permissionGeneration != generation) return
    if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) action?.invoke()
    else fail("Wi-Fi permission was denied. Allow Nearby devices (or Location on older Android) in app settings, then try again.")
  }

  private fun ready(): Boolean {
    if (wifi == null) { fail("Wi-Fi hardware is unavailable on this device. Use another device for hotspot transfers."); return false }
    if (!wifi.isWifiEnabled) { fail("Turn on Wi-Fi, then try again. No internet connection is needed."); return false }
    if (Build.VERSION.SDK_INT < 33) {
      val location = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      if (!location.isProviderEnabled(LocationManager.GPS_PROVIDER) && !location.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
        fail("This Android version requires Location services for Wi-Fi setup. Enable Location, then try again."); return false
      }
    }
    return true
  }

  @SuppressLint("MissingPermission")
  fun start() = activity.runOnUiThread {
    clearScan()
    if (Build.VERSION.SDK_INT < 26) { fail("Automatic hotspot creation needs Android 8 or later. Use system hotspot settings."); return@runOnUiThread }
    if (reservation != null || callback != null || JSONObject(snapshot).optString("mode") in listOf("starting", "joining")) {
      return@runOnUiThread
    }
    val token = ++generation
    snapshot = json("starting")
    withPermission {
      if (token != generation || !ready()) return@withPermission
      val before = addresses()
      try {
        wifi?.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
          override fun onStarted(created: WifiManager.LocalOnlyHotspotReservation) {
            if (token != generation) { created.close(); return }
            reservation = created
            val ssid: String?
            val password: String?
            if (Build.VERSION.SDK_INT >= 30) {
              ssid = created.softApConfiguration.ssid
              password = created.softApConfiguration.passphrase
            } else {
              @Suppress("DEPRECATION") val config = created.wifiConfiguration
              ssid = config?.SSID?.removeSurrounding("\"")
              password = config?.preSharedKey?.removeSurrounding("\"")
            }
            if (ssid.isNullOrBlank() || password.isNullOrBlank()) {
              created.close(); reservation = null
              fail("Android did not provide secure hotspot credentials. Try system hotspot settings."); return
            }
            snapshot = json("hosting", ssid, password)
            updateAddress(token, before, ssid, password, 10)
          }
          override fun onStopped() {
            if (token != generation) return
            reservation = null
            fail("The hotspot stopped. Keep PulseDrop open and start it again to reconnect.")
          }
          override fun onFailed(reason: Int) {
            if (token != generation) return
            fail(when (reason) {
              ERROR_INCOMPATIBLE_MODE -> "Another hotspot or tethering mode is active. Turn it off in Settings and try again."
              ERROR_NO_CHANNEL -> "No Wi-Fi channel is available. Move closer, check Wi-Fi settings, and try again."
              ERROR_TETHERING_DISALLOWED -> "Hotspots are restricted by this device's administrator. Use another receiver."
              else -> "Android could not create a hotspot. Check Wi-Fi and Nearby devices permission, then try again."
            })
          }
        }, handler)
      } catch (_: SecurityException) { fail("Wi-Fi permission is missing. Allow Nearby devices or Location in app settings and try again.") }
      catch (_: Exception) { fail("Hotspot setup failed. Check Wi-Fi settings and try again.") }
    }
  }

  private fun addresses(): Set<String> = try {
    NetworkInterface.getNetworkInterfaces().toList().filterNot {
      it.name.startsWith("rmnet") || it.name.startsWith("ccmni") || it.name.startsWith("tun")
    }.flatMap { it.inetAddresses.toList() }.filterIsInstance<Inet4Address>()
      .filter { it.isSiteLocalAddress }.map { it.hostAddress!! }.toSet()
  } catch (_: Exception) { emptySet() }

  private fun updateAddress(token: Int, before: Set<String>, ssid: String, password: String, retries: Int) {
    if (token != generation || reservation == null) return
    val address = (addresses() - before).firstOrNull()
    snapshot = json("hosting", ssid, password, address)
    if (address == null && retries > 0) handler.postDelayed({ updateAddress(token, before, ssid, password, retries - 1) }, 500)
  }

  @SuppressLint("MissingPermission")
  fun join(ssid: String, password: String, bssid: String = "") = activity.runOnUiThread {
    clearScan()
    if (Build.VERSION.SDK_INT < 29) { fail("Join the receiver's hotspot in system Wi-Fi settings on this Android version."); return@runOnUiThread }
    if (reservation != null) { fail("Stop this device's hotspot before joining another receiver."); return@runOnUiThread }
    if (ssid.toByteArray(Charsets.UTF_8).size !in 1..32 || password.length !in 8..63 || password.any { it.code !in 32..126 }) {
      fail("Enter the receiver's Wi-Fi name and its 8–63 character WPA2 password."); return@runOnUiThread
    }
    releaseNetwork()
    val token = ++generation
    snapshot = json("joining", ssid)
    withPermission {
      if (token != generation || !ready()) return@withPermission
      try {
        val builder = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(password)
        if (bssid.isNotBlank()) builder.setBssid(MacAddress.fromString(bssid))
        val specifier = builder.build()
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
          .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).setNetworkSpecifier(specifier).build()
        val listener = object : ConnectivityManager.NetworkCallback() {
          override fun onAvailable(network: Network) {
            if (token != generation) return
            if (!connectivity.bindProcessToNetwork(network)) {
              releaseNetwork(); fail("The hotspot connection was lost. Try joining again."); return
            }
            bound = true
            snapshot = json("joined", ssid, address = gateway(connectivity.getLinkProperties(network)))
          }
          override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
            if (token == generation && bound) snapshot = json("joined", ssid, address = gateway(properties))
          }
          override fun onUnavailable() {
            if (token != generation) return
            releaseNetwork(); fail("Connection was declined or timed out. Check the Wi-Fi password and accept Android's connection request.")
          }
          override fun onLost(network: Network) {
            if (token != generation) return
            releaseNetwork(); fail("The receiver's hotspot disconnected. Move closer or restart its hotspot, then join again.")
          }
        }
        callback = listener
        connectivity.requestNetwork(request, listener, handler, 45000)
      } catch (_: SecurityException) { releaseNetwork(); fail("Wi-Fi permission is missing. Allow Nearby devices or Location in app settings and try again.") }
      catch (_: Exception) { releaseNetwork(); fail("Could not join this hotspot. Check its name and WPA2 password or use system Wi-Fi settings.") }
    }
  }

  private fun gateway(properties: LinkProperties?): String? = properties?.routes?.firstOrNull {
    it.isDefaultRoute && it.gateway is Inet4Address && !it.gateway!!.isAnyLocalAddress
  }?.gateway?.hostAddress

  fun scanStatus(): String = scanSnapshot

  private fun clearScan() {
    ++scanGeneration; scanPermissionAction = null
    scanReceiver?.let { try { activity.unregisterReceiver(it) } catch (_: Exception) { } }
    scanReceiver = null
    scanSnapshot = JSONObject().put("state", "idle").toString()
  }

  fun stopScan() = activity.runOnUiThread { clearScan() }
  fun pauseScan() = activity.runOnUiThread { if (scanPermissionAction == null) clearScan() }

  private fun scanFail(message: String) {
    clearScan()
    scanSnapshot = JSONObject().put("state", "error").put("error", message).toString()
  }

  @SuppressLint("MissingPermission")
  fun scan() = activity.runOnUiThread {
    clearScan()
    val token = scanGeneration
    scanSnapshot = JSONObject().put("state", "scanning").toString()
    if (wifi == null || !wifi.isWifiEnabled) { scanFail("Turn on Wi-Fi and refresh. No internet is needed."); return@runOnUiThread }
    if (reservation != null || permissionAction != null) { scanFail("Finish hotspot setup before searching for another device."); return@runOnUiThread }
    val action: () -> Unit = action@{
      if (token != scanGeneration) return@action
      val location = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      if (!location.isProviderEnabled(LocationManager.GPS_PROVIDER) && !location.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
        scanFail("Android requires Location services to list nearby Wi-Fi. Enable Location and refresh, or scan the other device’s QR instead."); return@action
      }
      fun publish(): Boolean {
        val cutoff = SystemClock.elapsedRealtime() * 1000 - 120000000L
        val networks = wifi.scanResults.filter { it.timestamp >= cutoff }
          .mapNotNull { result ->
            @Suppress("DEPRECATION") val name = result.SSID
            if (name.isNullOrEmpty() || name.toByteArray(Charsets.UTF_8).size > 32 || name.any { it.code < 32 || it.code == 127 }) return@mapNotNull null
            val security = if (result.capabilities.contains("PSK") && result.capabilities.contains("WPA2")) "WPA2"
              else if (result.capabilities.contains("PSK") && result.capabilities.contains("RSN")) "WPA2"
              else if (result.capabilities.contains("SAE")) "WPA3"
              else if (result.capabilities.contains("EAP")) "Enterprise"
              else if (result.capabilities.contains("WEP")) "WEP" else "Open"
            JSONObject().put("ssid", name).put("bssid", result.BSSID ?: "")
              .put("signal", ((result.level + 100) * 2).coerceIn(0, 100)).put("security", security).put("interface", "wifi")
          }.distinctBy { it.optString("ssid") + "/" + it.optString("bssid") }
          .sortedByDescending { it.optInt("signal") }.take(64)
        if (networks.isEmpty()) return false
        clearScan()
        scanSnapshot = JSONObject().put("state", "done").put("networks", JSONArray(networks)).toString()
        return true
      }
      try {
        val listener = object : BroadcastReceiver() {
          override fun onReceive(context: Context?, intent: Intent?) {
            if (token != scanGeneration) return
            try {
              if (!publish()) {
                clearScan(); scanSnapshot = JSONObject().put("state", "done").put("networks", JSONArray()).toString()
              }
            } catch (_: SecurityException) { scanFail("Allow precise Location access and enable Location services, then refresh Wi-Fi.") }
          }
        }
        scanReceiver = listener
        ContextCompat.registerReceiver(activity, listener, IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), ContextCompat.RECEIVER_EXPORTED)
        // Foreground scans are OS-throttled. Recent results remain useful while
        // keeping the refresh bounded; no continuous/background scanning.
        @Suppress("DEPRECATION") val started = wifi.startScan()
        if (!started) {
          if (!publish()) scanFail("Android is limiting Wi-Fi scans. Wait a moment and refresh, or scan the other device’s QR.")
        } else handler.postDelayed({
          if (token == scanGeneration) {
            try { if (!publish()) scanFail("No Wi-Fi scan results yet. Move closer and refresh, or scan the other device’s QR.") }
            catch (_: SecurityException) { scanFail("Allow precise Location access, then refresh Wi-Fi.") }
          }
        }, 15000)
      } catch (_: SecurityException) { scanFail("Allow precise Location access and enable Location services, then refresh Wi-Fi.") }
      catch (_: Exception) { scanFail("Wi-Fi scan failed. Enable Wi-Fi and try again, or scan a QR.") }
    }
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) action()
    else {
      scanPermissionAction = action
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION), SCAN_PERMISSION_REQUEST)
    }
  }

  private fun releaseNetwork() {
    if (bound) { connectivity.bindProcessToNetwork(null); bound = false }
    val old = callback; callback = null
    if (old != null) try { connectivity.unregisterNetworkCallback(old) } catch (_: Exception) { }
  }

  fun stop() = activity.runOnUiThread {
    clearScan()
    ++generation; permissionAction = null
    reservation?.close(); reservation = null
    releaseNetwork()
    snapshot = json("idle")
  }

  fun openSettings(hosting: Boolean) = activity.runOnUiThread {
    // Use public settings actions; the user owns changes to an external hotspot.
    try { activity.startActivity(Intent(if (hosting) Settings.ACTION_WIRELESS_SETTINGS else Settings.ACTION_WIFI_SETTINGS)) }
    catch (_: Exception) { fail("Open Wi-Fi in the Settings app.") }
  }

  companion object { const val PERMISSION_REQUEST = 53614; const val SCAN_PERMISSION_REQUEST = 53615 }
}
