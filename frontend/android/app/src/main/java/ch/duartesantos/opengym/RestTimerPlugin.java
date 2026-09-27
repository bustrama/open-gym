package ch.duartesantos.opengym;

import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The rest countdown on the status bar and the lock screen: one silent, ongoing notification
 * whose chronometer counts down to the end of the rest. The system draws the countdown, so no
 * foreground service keeps the app alive for it, and the notification removes itself when the
 * rest is over. The alert at the end is a separate local notification (src/lib/rest-notify.js):
 * this one has to stay silent.
 *
 * Android 16 can promote it to a Live Update, the status-bar chip. It asks for that with the
 * android.requestPromotedOngoing extra, set by name because compileSdk 35 does not have the
 * constant, and the POST_PROMOTED_NOTIFICATIONS permission in the manifest. Anything that would
 * rule promotion out (a custom layout, a colorized notification) is left out on purpose.
 *
 * Usage from JS:
 *   import { registerPlugin } from '@capacitor/core';
 *   const RestTimer = registerPlugin('RestTimer');
 *   await RestTimer.start({ endsAt, title, text, channelName });
 *   await RestTimer.stop();
 */
@CapacitorPlugin(name = "RestTimer")
public class RestTimerPlugin extends Plugin {

    private static final String CHANNEL_ID = "rest-countdown";
    private static final int NOTIFICATION_ID = 7100;

    // areNotificationsEnabled() answers the permission question before notify() is reached.
    @SuppressLint("MissingPermission")
    @PluginMethod
    public void start(PluginCall call) {
        Long endsAt = call.getLong("endsAt");
        if (endsAt == null) {
            call.reject("endsAt is required");
            return;
        }
        Context context = getContext();
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        long left = endsAt - System.currentTimeMillis();
        if (left <= 0 || !manager.areNotificationsEnabled()) {
            manager.cancel(NOTIFICATION_ID);
            call.resolve();
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Low: in the status bar and on the lock screen, never a sound or a heads-up banner.
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    call.getString("channelName", "Rest timer"),
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setShowBadge(false);
            context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }

        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent open = launch == null ? null : PendingIntent.getActivity(
                context, NOTIFICATION_ID, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_opengym)
                .setContentTitle(call.getString("title", "Rest"))
                .setContentText(call.getString("text", ""))
                .setWhen(endsAt)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setTimeoutAfter(left)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(open);
        builder.getExtras().putBoolean("android.requestPromotedOngoing", true);

        try {
            manager.notify(NOTIFICATION_ID, builder.build());
        } catch (SecurityException e) {
            // The permission went away between the check and the post: nothing to show.
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
        call.resolve();
    }
}
