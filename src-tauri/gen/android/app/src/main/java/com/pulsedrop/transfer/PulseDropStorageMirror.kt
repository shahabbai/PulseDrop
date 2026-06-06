package com.pulsedrop.transfer

import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import android.widget.Toast
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

object PulseDropStorageMirror {
  private const val PREFS = "pulsedrop_storage_mirror"
  private const val PUBLIC_RELATIVE_PATH = "Download/PulseDrop/Inbox"
  private val handler = Handler(Looper.getMainLooper())
  private val executor = Executors.newSingleThreadExecutor()
  private val observedSizes = mutableMapOf<String, Long>()
  private var appContext: Context? = null
  private var running = false

  private val task = object : Runnable {
    override fun run() {
      val context = appContext
      if (running && context != null) {
        executor.execute { mirrorFinishedFiles(context) }
        handler.postDelayed(this, 2500)
      }
    }
  }

  fun start(context: Context) {
    appContext = context.applicationContext
    if (running) return
    running = true
    handler.postDelayed(task, 1000)
  }

  fun stop() {
    running = false
    handler.removeCallbacks(task)
  }

  fun openInbox(activity: Activity) {
    val intents = mutableListOf<Intent>()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
      val inboxUri = DocumentsContract.buildDocumentUri(
        "com.android.externalstorage.documents",
        "primary:Download/PulseDrop/Inbox",
      )
      intents.add(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(inboxUri, DocumentsContract.Document.MIME_TYPE_DIR)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      })

      val downloadsUri = DocumentsContract.buildDocumentUri(
        "com.android.externalstorage.documents",
        "primary:Download",
      )
      intents.add(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(downloadsUri, DocumentsContract.Document.MIME_TYPE_DIR)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      })
    }

    intents.add(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS))
    intents.add(Intent(Intent.ACTION_VIEW).apply {
      setData(Uri.parse("content://com.android.providers.downloads.documents/root/downloads"))
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    })

    for (intent in intents) {
      try {
        activity.startActivity(intent)
        return
      } catch (_: ActivityNotFoundException) {
      } catch (_: SecurityException) {
      } catch (_: IllegalArgumentException) {
      }
    }

    Toast.makeText(activity, "Open Downloads and go to PulseDrop/Inbox", Toast.LENGTH_LONG).show()
  }

  private fun mirrorFinishedFiles(context: Context) {
    for (dir in privateInboxCandidates(context)) {
      val files = dir.listFiles { file -> file.isFile } ?: continue
      for (file in files) {
        if (!isStable(file)) continue
        val key = file.name + ":" + file.length() + ":" + file.lastModified()
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(key, false)) continue

        try {
          copyToPublicDownloads(context, file)
          prefs.edit().putBoolean(key, true).apply()
        } catch (error: Exception) {
          Logger.warn(Logger.tags("PulseDropStorage"), "Could not mirror " + file.name + ": " + (error.message ?: "unknown error"))
        }
      }
    }
  }

  private fun privateInboxCandidates(context: Context): List<File> {
    val dirs = mutableListOf<File>()
    context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.let {
      dirs.add(File(it, "PulseDrop/Inbox"))
    }
    context.getExternalFilesDir(null)?.let {
      dirs.add(File(it, "Download/PulseDrop/Inbox"))
      dirs.add(File(it, "PulseDrop/Inbox"))
    }
    return dirs.distinctBy { it.absolutePath }
  }

  private fun isStable(file: File): Boolean {
    val path = file.absolutePath
    val size = file.length()
    val previous = observedSizes[path]
    observedSizes[path] = size
    return size > 0L && previous == size
  }

  private fun copyToPublicDownloads(context: Context, source: File) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      copyWithMediaStore(context, source)
    } else {
      @Suppress("DEPRECATION")
      val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PulseDrop/Inbox")
      dir.mkdirs()
      source.inputStream().use { input ->
        File(dir, source.name).outputStream().use { output -> input.copyTo(output) }
      }
    }
  }

  private fun copyWithMediaStore(context: Context, source: File) {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, source.name)
      put(MediaStore.MediaColumns.MIME_TYPE, mimeTypeFor(source.name))
      put(MediaStore.MediaColumns.RELATIVE_PATH, PUBLIC_RELATIVE_PATH)
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }

    val uri: Uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("Could not create Downloads entry")

    try {
      resolver.openOutputStream(uri)?.use { output ->
        source.inputStream().use { input -> input.copyTo(output) }
      } ?: throw IllegalStateException("Could not open Downloads output stream")

      val readyValues = ContentValues().apply {
        put(MediaStore.MediaColumns.IS_PENDING, 0)
      }
      resolver.update(uri, readyValues, null, null)
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
  }

  private fun mimeTypeFor(name: String): String {
    val extension = name.substringAfterLast(".", "").lowercase(Locale.US)
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
  }
}