package app.forkcast.securestore

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class KeyArgs {
    lateinit var key: String
}

@InvokeArg
class ValueArgs {
    lateinit var key: String
    lateinit var value: String
}

/**
 * Session tokens, encrypted with an AES-256-GCM key held in the Android
 * Keystore. The key is not exportable and is not part of any backup, and the
 * ciphertext lives in a preferences file the app excludes from backup and
 * device transfer, so a restored copy is unreadable and simply means "sign in
 * again".
 */
@TauriPlugin
class SecureStorePlugin(private val activity: Activity) : Plugin(activity) {
    private val alias = "forkcast-secrets-v1"
    private val preferences by lazy {
        activity.getSharedPreferences("forkcast_secrets", Context.MODE_PRIVATE)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator =
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun seal(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + sealed, Base64.NO_WRAP)
    }

    private fun open(stored: String): String? =
        try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        } catch (error: Exception) {
            // A restored copy, or a key lost with the device: treat as signed out.
            null
        }

    @Command
    fun get(invoke: Invoke) {
        val args = invoke.parseArgs(KeyArgs::class.java)
        val value = preferences.getString(args.key, null)?.let { open(it) }
        invoke.resolve(JSObject().apply { put("value", value) })
    }

    @Command
    fun set(invoke: Invoke) {
        val args = invoke.parseArgs(ValueArgs::class.java)
        preferences.edit().putString(args.key, seal(args.value)).commit()
        invoke.resolve()
    }

    @Command
    fun delete(invoke: Invoke) {
        val args = invoke.parseArgs(KeyArgs::class.java)
        preferences.edit().remove(args.key).commit()
        invoke.resolve()
    }
}
