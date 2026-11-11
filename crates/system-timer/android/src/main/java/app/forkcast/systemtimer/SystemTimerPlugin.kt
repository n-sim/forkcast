package app.forkcast.systemtimer

import android.app.Activity
import android.content.Intent
import android.provider.AlarmClock
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class TimerArgs {
    var seconds: Int = 0
    lateinit var label: String
}

/**
 * Starts a countdown in the device's clock app through
 * `AlarmClock.ACTION_SET_TIMER`. The clock app owns the timer from then on: it
 * keeps running and rings while Forkcast is closed. Any failure (no clock app
 * handles the intent, the permission is missing, an out-of-range length) is
 * rejected so that the frontend starts its own timer instead.
 */
@TauriPlugin
class SystemTimerPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun setTimer(invoke: Invoke) {
        val args = invoke.parseArgs(TimerArgs::class.java)
        // The intent accepts 1 second to 24 hours.
        if (args.seconds < 1 || args.seconds > 86_400) {
            invoke.reject("A clock app timer must last 1 second to 24 hours.")
            return
        }
        val intent =
            Intent(AlarmClock.ACTION_SET_TIMER).apply {
                putExtra(AlarmClock.EXTRA_LENGTH, args.seconds)
                putExtra(AlarmClock.EXTRA_MESSAGE, args.label)
                // Start counting at once and stay in Forkcast.
                putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            }
        try {
            activity.startActivity(intent)
            invoke.resolve()
        } catch (error: Exception) {
            // ActivityNotFoundException (no clock app) or SecurityException.
            invoke.reject(error.message ?: "No clock app could start the timer.")
        }
    }
}
