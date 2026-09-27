package ch.duartesantos.opengym;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.getcapacitor.JSObject;

/**
 * The rest countdown's buttons (−15s, +15s, Skip) and the alarm at its end. Runs with the app in
 * the background, the phone locked, or in a process started just for it: the rest it works on
 * is the one RestTimer kept, and the app hears of a change when it is running
 * (RestTimerPlugin.emit). Everything here is quick, so no goAsync.
 */
public class RestTimerReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        // An exception out of a receiver kills the app's process, workout screen and all.
        try {
            String action = intent.getAction();
            if (RestTimer.ACTION_ALERT.equals(action)) {
                RestTimer.ring(context, intent);
                return;
            }
            JSObject change = null;
            if (RestTimer.ACTION_ADD.equals(action)) {
                change = RestTimer.add(context, intent.getIntExtra(RestTimer.EXTRA_SECONDS, 0));
            } else if (RestTimer.ACTION_SKIP.equals(action)) {
                change = RestTimer.skip(context);
            }
            if (change != null) RestTimerPlugin.emit(change);
        } catch (Exception e) {
            Log.w("RestTimer", "rest button failed", e);
        }
    }
}
