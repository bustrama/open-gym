package ch.duartesantos.opengym;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
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
 * start() answers { shown, reason } instead of failing quietly, and status() says what Android
 * actually has up, so the app can tell the user why nothing appears.
 *
 * Usage from JS:
 *   import { registerPlugin } from '@capacitor/core';
 *   const RestTimer = registerPlugin('RestTimer');
 *   await RestTimer.start({ endsAt, title, text, channelName }); // { shown, reason? }
 *   await RestTimer.status();   // { enabled, channel, active, promotable, promoted, canPromote, sdk }
 *   await RestTimer.stop();
 */
@CapacitorPlugin(name = "RestTimer")
public class RestTimerPlugin extends Plugin {

    // Default importance, made silent below. The first channel ("rest-countdown") was Low, and
    // Android treats a Low notification as silent: no status-bar icon, and in the shade it sits
    // folded away under "Silent". A channel's importance cannot change once it exists, hence
    // the new id; the old channel is deleted so it does not linger in the app's settings.
    private static final String CHANNEL_ID = "rest-timer";
    private static final String OLD_CHANNEL_ID = "rest-countdown";
    private static final int NOTIFICATION_ID = 7100;

    // areNotificationsEnabled() answers the permission question before notify() is reached.
    @SuppressLint("MissingPermission")
    @PluginMethod
    public void start(PluginCall call) {
        // optLong takes the number whichever way the bridge parsed it (int, long or double).
        long endsAt = call.getData().optLong("endsAt", 0);
        if (endsAt <= 0) {
            call.reject("endsAt is required");
            return;
        }
        // An exception thrown out of a plugin method takes the whole app down (Capacitor
        // rethrows it), so everything below reports back instead.
        try {
            Context context = getContext();
            NotificationManagerCompat manager = NotificationManagerCompat.from(context);
            long left = endsAt - System.currentTimeMillis();
            if (left <= 0) {
                manager.cancel(NOTIFICATION_ID);
                call.resolve(result(false, "over"));
                return;
            }
            if (!manager.areNotificationsEnabled()) {
                call.resolve(result(false, "notifications-off"));
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationManager system = context.getSystemService(NotificationManager.class);
                ensureChannel(system, call.getString("channelName", "Rest timer"));
                NotificationChannel channel = system.getNotificationChannel(CHANNEL_ID);
                if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                    call.resolve(result(false, "channel-off"));
                    return;
                }
            }

            Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            PendingIntent open = launch == null ? null : PendingIntent.getActivity(
                    context, NOTIFICATION_ID, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_opengym)
                    .setContentTitle(call.getString("title", "Rest"))
                    .setContentText(call.getString("text", ""))
                    .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
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

            manager.notify(NOTIFICATION_ID, builder.build());
            call.resolve(result(true, null));
        } catch (SecurityException e) {
            // The permission went away between the check and the post.
            call.resolve(result(false, "notifications-off"));
        } catch (Exception e) {
            call.resolve(result(false, e.getClass().getSimpleName() + ": " + e.getMessage()));
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
        } catch (Exception e) {
            // Nothing up, or nothing to cancel it with: either way nothing is showing.
        }
        call.resolve();
    }

    // What Android has: notifications allowed, the channel's importance (-1 before the first
    // rest creates it), whether the countdown is up right now and whether Android 16 promoted it.
    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("sdk", Build.VERSION.SDK_INT);
        try {
            Context context = getContext();
            out.put("enabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
            NotificationManager system = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = system.getNotificationChannel(CHANNEL_ID);
                out.put("channel", channel == null ? -1 : channel.getImportance());
            }
            boolean active = false;
            for (StatusBarNotification sbn : system.getActiveNotifications()) {
                if (sbn.getId() != NOTIFICATION_ID) continue;
                active = true;
                Notification n = sbn.getNotification();
                // Android 16 API, by reflection for compileSdk 35: whether this notification
                // qualifies for a Live Update, and whether it got promoted to one.
                Object promotable = call36(n, "hasPromotableCharacteristics");
                if (promotable != null) out.put("promotable", promotable);
                try {
                    int flag = Notification.class.getField("FLAG_PROMOTED_ONGOING").getInt(null);
                    out.put("promoted", (n.flags & flag) != 0);
                } catch (Exception ignored) {
                    // Before Android 16: nothing is promoted.
                }
            }
            out.put("active", active);
            // The user's per-app "Live notifications" switch (Android 16).
            Object can = call36(system, "canPostPromotedNotifications");
            if (can != null) out.put("canPromote", can);
        } catch (Exception e) {
            out.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        call.resolve(out);
    }

    private static void ensureChannel(NotificationManager system, String name) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (system.getNotificationChannel(OLD_CHANNEL_ID) != null) system.deleteNotificationChannel(OLD_CHANNEL_ID);
        // In the status bar, on the lock screen and in the shade's main list, yet never a sound,
        // a vibration or a heads-up banner (that takes High).
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        // Creating an existing channel only renames it: the user's own changes to it stay.
        system.createNotificationChannel(channel);
    }

    // A no-argument method of Android 16 (API 36), or null where there is none.
    private static Object call36(Object target, String method) {
        if (Build.VERSION.SDK_INT < 36) return null;
        try {
            return target.getClass().getMethod(method).invoke(target);
        } catch (Exception e) {
            return null;
        }
    }

    private static JSObject result(boolean shown, String reason) {
        JSObject out = new JSObject();
        out.put("shown", shown);
        if (reason != null) out.put("reason", reason);
        return out;
    }
}
