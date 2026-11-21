package com.pulsedrop.transfer

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/** Downloads an APK from the official release and hands it to Android's package installer. */
class PulseDropUpdater(private val activity: MainActivity) {
  private data class Candidate(val version: String, val code: Long, val sha256: String) {
    val filename = "PulseDrop_${version}_android_arm64.apk"
  }

  private val worker = Executors.newFixedThreadPool(2)
  @Volatile private var snapshot = """{"phase":"idle"}"""
  @Volatile private var availability = "{}"
  @Volatile private var running = false
  @Volatile private var closed = false
  private var ready: Pair<Candidate, File>? = null
  private var awaitingPermission = false

  fun status(): String = snapshot

  fun availabilityStatus(): String = availability

  @Synchronized
  fun checkAvailability() {
    if (closed || availability.isEmpty()) return
    availability = ""
    worker.execute {
      availability = try {
        val version = if ("arm64-v8a" in Build.SUPPORTED_ABIS) findUpdate()?.version else null
        JSONObject().put("version", version).toString()
      } catch (error: Exception) {
        """{"error":true}"""
      }
    }
  }

  @Synchronized
  fun start() {
    if (running || closed || ready != null) return
    running = true
    report("checking")
    worker.execute {
      var partial: File? = null
      try {
        val candidate = findUpdate()
        if (candidate == null) {
          report("current")
          return@execute
        }
        if ("arm64-v8a" !in Build.SUPPORTED_ABIS) {
          error("This release requires an ARM64 Android phone.")
        }

        val directory = File(activity.cacheDir, "updates").apply { mkdirs() }
        // Remove leftovers from an earlier app process before staging another APK.
        directory.listFiles()?.filter { it.name.startsWith("pulsedrop-") }?.forEach { it.delete() }
        val apk = File.createTempFile("pulsedrop-", ".apk", directory)
        partial = apk
        download(candidate, apk)
        verifyPackage(candidate, apk)
        synchronized(this) {
          if (closed) return@execute
          ready = candidate to apk
          partial = null
        }
        activity.runOnUiThread { install() }
      } catch (error: UpdateFailure) {
        report("error", message = error.message)
      } catch (error: Exception) {
        report("error", message = "Could not download the update. Check your internet connection and available storage, then try again.")
      } finally {
        partial?.delete()
        running = false
      }
    }
  }

  @Synchronized
  fun install() {
    val (candidate, apk) = ready ?: return
    if (closed || activity.isFinishing) return
    try {
      if (!apk.isFile) {
        ready = null
        report("error", message = "The downloaded update was removed. Check for updates again.")
        return
      }
      if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
        awaitingPermission = true
        report("permission", candidate.version)
        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
        return
      }
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
      report("ready", candidate.version)
      activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      })
    } catch (error: Exception) {
      awaitingPermission = false
      report("ready", candidate.version, "Android could not open the installer. Try again or install the APK from GitHub Releases.")
    }
  }

  @Synchronized
  fun resumeAfterPermission() {
    if (!awaitingPermission) return
    awaitingPermission = false
    if (Build.VERSION.SDK_INT >= 26 && activity.packageManager.canRequestPackageInstalls()) install()
  }

  @Synchronized
  fun close() {
    closed = true
    worker.shutdownNow()
  }

  private fun findUpdate(): Candidate? {
    val manifest = request(URL("$RELEASES/latest/download/latest.json")) { input, _ ->
      val bytes = readLimited(input, 256 * 1024)
      JSONObject(bytes.toString(Charsets.UTF_8))
    }
    val version = manifest.getString("version")
    val parts = VERSION.matchEntire(version)?.groupValues?.drop(1)?.map { it.toLong() }
      ?: error("GitHub returned an invalid release version.")
    val code = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
    if (code !in 1L..2_100_000_000L) error("GitHub returned an invalid release version.")
    val installed = activity.packageManager.getPackageInfo(activity.packageName, 0)
    if (code <= versionCode(installed)) return null

    val android = manifest.getJSONObject("android")
    val hash = android.getString("sha256")
    if (!SHA256.matches(hash)) error("The update checksum is invalid.")
    return Candidate(version, code, hash)
  }

  private fun download(candidate: Candidate, apk: File) {
    report("downloading", candidate.version, received = 0)
    val digest = MessageDigest.getInstance("SHA-256")
    val deadline = SystemClock.elapsedRealtime() + 20 * 60 * 1000L
    request(URL("$RELEASES/download/v${candidate.version}/${candidate.filename}")) { input, length ->
      if (length > MAX_APK_BYTES) error("The update file is too large.")
      apk.outputStream().buffered().use { out ->
        val buffer = ByteArray(128 * 1024)
        var bytes = 0L
        var lastReport = 0L
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          bytes += count
          val now = SystemClock.elapsedRealtime()
          if (closed || bytes > MAX_APK_BYTES || now > deadline) error("The update download was stopped.")
          digest.update(buffer, 0, count)
          out.write(buffer, 0, count)
          if (now - lastReport >= 250) {
            report("downloading", candidate.version, received = bytes, total = length.takeIf { it > 0 })
            lastReport = now
          }
        }
        if (length > 0 && bytes != length) error("The update download was incomplete.")
      }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it) }
    if (actual != candidate.sha256) error("The update checksum did not match. Check for updates again.")
  }

  @Suppress("DEPRECATION")
  private fun verifyPackage(candidate: Candidate, apk: File) {
    val manager = activity.packageManager
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val installed = manager.getPackageInfo(activity.packageName, flags)
    val downloaded = manager.getPackageArchiveInfo(apk.absolutePath, flags)
    if (downloaded == null || downloaded.packageName != installed.packageName ||
      downloaded.versionName != candidate.version || versionCode(downloaded) != candidate.code ||
      versionCode(downloaded) <= versionCode(installed) || signers(installed).isEmpty() ||
      signers(downloaded) != signers(installed)
    ) error("The APK does not match this installation of PulseDrop. Install updates signed with your original app key.")
  }

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures?.map { it.toCharsString() }?.toSet().orEmpty()
  }

  @Suppress("DEPRECATION")
  private fun versionCode(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  private fun <T> request(initial: URL, read: (InputStream, Long) -> T): T {
    var url = initial
    repeat(6) {
      if (url.protocol != "https" || url.host !in DOWNLOAD_HOSTS ||
        url.userInfo != null || url.port !in listOf(-1, 443)
      ) error("The update download address is invalid.")
      val connection = url.openConnection() as HttpsURLConnection
      try {
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept-Encoding", "identity")
        when (connection.responseCode) {
          200 -> return connection.inputStream.use { read(it, connection.contentLengthLong) }
          301, 302, 303, 307, 308 -> url = URL(url, connection.getHeaderField("Location")
            ?: error("GitHub returned an invalid redirect."))
          else -> error("Could not check or download the update from GitHub. Try again later.")
        }
      } finally {
        connection.disconnect()
      }
    }
    error("GitHub returned too many update redirects.")
  }

  private fun readLimited(input: InputStream, limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    val deadline = SystemClock.elapsedRealtime() + 30_000
    while (true) {
      val count = input.read(buffer)
      if (count < 0) return output.toByteArray()
      if (closed || output.size() + count > limit || SystemClock.elapsedRealtime() > deadline) {
        error("Could not read the release information from GitHub.")
      }
      output.write(buffer, 0, count)
    }
  }

  private fun report(phase: String, version: String? = null, message: String? = null,
                     received: Long? = null, total: Long? = null) {
    snapshot = JSONObject().put("phase", phase).put("version", version).put("message", message)
      .put("received", received).put("total", total).toString()
  }

  private class UpdateFailure(message: String) : Exception(message)
  private fun error(message: String): Nothing = throw UpdateFailure(message)

  companion object {
    private const val RELEASES = "https://github.com/shahabbai/PulseDrop/releases"
    private const val MAX_APK_BYTES = 512L * 1024 * 1024
    private val VERSION = Regex("(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})")
    private val SHA256 = Regex("[a-f0-9]{64}")
    private val DOWNLOAD_HOSTS = setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
  }
}
