package app.forkcast.share

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
    lateinit var name: String
    lateinit var data: String
    lateinit var mimeType: String
    lateinit var title: String
}

/**
 * Offers a generated file to other apps through the system share sheet
 * (`ACTION_SEND`). The file is written to a cache folder that the app's
 * `FileProvider` serves (see `res/xml/file_paths.xml` in the app), and only
 * the app the person picks is granted read access to it.
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun share(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareArgs::class.java)
            val folder = File(activity.cacheDir, "shared")
            // Only the latest shared file is kept; earlier ones were already handed over.
            folder.deleteRecursively()
            folder.mkdirs()
            val name = File(args.name).name.ifEmpty { "forkcast.pdf" }
            val file = File(folder, name)
            file.writeBytes(Base64.decode(args.data, Base64.NO_WRAP))
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file,
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = args.mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, args.title)
                putExtra(Intent.EXTRA_TITLE, args.title)
                clipData = ClipData.newRawUri(name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, args.title).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(chooser)
                    invoke.resolve()
                } catch (error: Exception) {
                    invoke.reject(error.message ?: "The share sheet could not be opened.")
                }
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The file could not be prepared for sharing.")
        }
    }
}
