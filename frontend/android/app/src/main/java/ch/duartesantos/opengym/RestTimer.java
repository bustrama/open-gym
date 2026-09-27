package ch.duartesantos.opengym;

import android.annotation.SuppressLint;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The rest on the phone, apart from the app: the countdown notification with its −15s, +15s and
 * Skip buttons, and the alarm that rings the alert at the end. RestTimerPlugin starts and stops
 * a rest for the app; RestTimerReceiver handles the buttons and the alarm, with the app in the
 * background, the phone locked, or no app process at all. So the rest the app handed over is
 * kept in SharedPreferences: that is all a button needs to redraw the countdown and move the
 * alarm. The app hears of the change through RestTimerPlugin.emit.
 *
 * The countdown is one silent, ongoing notification whose chronometer counts down to the end of
 * the rest. The system draws the countdown, so no foreground service keeps the app alive for it,
 * and the notification removes itself when the rest is over. The alert is a separate
 * notification on a channel that sounds and vibrates: a watch that mirrors the phone's
 * notifications buzzes with it.
 *
 * Android 16 can promote the countdown to a Live Update, the status-bar chip. It asks for that
 * with the android.requestPromotedOngoing extra, set by name because compileSdk 35 does not have
 * the constant, and the POST_PROMOTED_NOTIFICATIONS permission in the manifest. Anything that
 * would rule promotion out (a custom layout, a colorized notification, a group summary) is left
 * out on purpose. Plain actions are fine.
 */
final class RestTimer {

    // Default importance, made silent below. The first channel ("rest-countdown") was Low, and
    // Android treats a Low notification as silent: no status-bar icon, and in the shade it sits
    // folded away under "Silent". A channel's importance cannot change once it exists, hence
    // the new id; the old channel is deleted so it does not linger in the app's settings.
    static final String CHANNEL_ID = "rest-timer";
    private static final String OLD_CHANNEL_ID = "rest-countdown";
    // Made by @capacitor/local-notifications in the builds that rang the alert through it.
    static final String ALERT_CHANNEL_ID = "rest-over";
    static final int NOTIFICATION_ID = 7100;
    static final int ALERT_ID = 7101;
    // One PendingIntent per button: the request code keeps them apart.
    private static final int LESS_ID = 7102;
    private static final int MORE_ID = 7103;
    private static final int SKIP_ID = 7104;

    static final String ACTION_ADD = "ch.duartesantos.opengym.REST_ADD";
    static final String ACTION_SKIP = "ch.duartesantos.opengym.REST_SKIP";
    static final String ACTION_ALERT = "ch.duartesantos.opengym.REST_ALERT";
    static final String EXTRA_SECONDS = "seconds";

    private static final String PREFS = "rest-timer";
    private static final String PREF_REST = "rest";

    private RestTimer() {}

    // ---- the rest as the app handed it over: { key, endsAt, title, text, channelName, alertTitle,
    // alertText, alertChannelName, step, lessLabel, moreLabel, skipLabel } ----

    static JSONObject load(Context context) {
        String saved = prefs(context).getString(PREF_REST, null);
        if (saved == null) return null;
        try {
            return new JSONObject(saved);
        } catch (JSONException e) {
            return null;
        }
    }

    static void save(Context context, JSONObject rest) {
        prefs(context).edit().putString(PREF_REST, rest.toString()).apply();
    }

    private static void forget(Context context) {
        prefs(context).edit().remove(PREF_REST).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // optString answers "null" for a JSON null; a label or a title never should.
    static String str(JSONObject o, String name, String fallback) {
        return o.isNull(name) ? fallback : o.optString(name, fallback);
    }

    private static int step(JSONObject rest) {
        int step = rest.optInt("step", 15);
        return step > 0 ? step : 15;
    }

    // ---- starting, moving and ending a rest ----

    /**
     * Posts the rest, or redraws it: the countdown and the alarm for the alert. Answers
     * { shown, reason?, alertError? }; the two stand apart, either channel can be turned off on
     * its own in Android's settings, and a countdown that fails must not take the alert down.
     */
    static JSObject start(Context context, JSONObject rest) {
        JSObject out = new JSObject();
        if (rest.optLong("endsAt", 0) <= System.currentTimeMillis()) {
            stop(context, false);
            out.put("shown", false);
            out.put("reason", "over");
            return out;
        }
        save(context, rest);
        // The last rest's alert, if it is still in the shade: stale now, and next to the
        // countdown it would have Android bundle the two, buttons folded away.
        try {
            NotificationManagerCompat.from(context).cancel(ALERT_ID);
        } catch (Exception e) {
            // Nothing to cancel.
        }
        String reason = post(context, rest);
        out.put("shown", reason == null);
        if (reason != null) out.put("reason", reason);
        String alertError = scheduleAlert(context, rest);
        if (alertError != null) out.put("alertError", alertError);
        return out;
    }

    /** Ends the rest. keepAlert: it ran out unwatched, and the alert is what tells the user. */
    static void stop(Context context, boolean keepAlert) {
        forget(context);
        try {
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
        } catch (Exception e) {
            // Nothing up, or nothing to cancel it with: either way nothing is showing.
        }
        if (!keepAlert) cancelAlert(context);
    }

    /**
     * The −15s / +15s buttons. Answers the change for the app, { key, endsAt }, or null when there
     * is no rest to move: a button tapped on a countdown whose rest is already over.
     */
    static JSObject add(Context context, int seconds) {
        JSONObject rest = load(context);
        long now = System.currentTimeMillis();
        if (rest == null || rest.optLong("endsAt", 0) <= now) return null;
        long endsAt = rest.optLong("endsAt", 0) + seconds * 1000L;
        // Taking off more than is left means "I'm ready now", as in the app (useUI addRest).
        if (endsAt - now < 1000) return skip(context);
        try {
            rest.put("endsAt", endsAt);
        } catch (JSONException e) {
            return null;
        }
        start(context, rest);
        JSObject change = new JSObject();
        change.put("key", str(rest, "key", ""));
        change.put("endsAt", endsAt);
        return change;
    }

    /** The Skip button: the rest ends, and its alert with it. Answers { key, skipped } for the app. */
    static JSObject skip(Context context) {
        JSONObject rest = load(context);
        stop(context, false);
        if (rest == null) return null;
        JSObject change = new JSObject();
        change.put("key", str(rest, "key", ""));
        change.put("skipped", true);
        return change;
    }

    // ---- the countdown ----

    // areNotificationsEnabled() answers the permission question before notify() is reached.
    // Answers null when the countdown is up, or why it is not.
    @SuppressLint("MissingPermission")
    private static String post(Context context, JSONObject rest) {
        try {
            NotificationManagerCompat manager = NotificationManagerCompat.from(context);
            long endsAt = rest.optLong("endsAt", 0);
            long left = endsAt - System.currentTimeMillis();
            if (left <= 0) {
                manager.cancel(NOTIFICATION_ID);
                return "over";
            }
            if (!manager.areNotificationsEnabled()) return "notifications-off";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationManager system = context.getSystemService(NotificationManager.class);
                ensureChannel(system, str(rest, "channelName", "Rest timer"));
                NotificationChannel channel = system.getNotificationChannel(CHANNEL_ID);
                if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return "channel-off";
            }

            int step = step(rest);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_opengym)
                    .setContentTitle(str(rest, "title", "Rest"))
                    .setContentText(str(rest, "text", ""))
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
                    .setContentIntent(openApp(context))
                    // Broadcasts, not activities: they run on the lock screen without an unlock
                    // and without bringing the app up (RestTimerReceiver).
                    .addAction(0, str(rest, "lessLabel", "−" + step + "s"), button(context, LESS_ID, ACTION_ADD, -step))
                    .addAction(0, str(rest, "moreLabel", "+" + step + "s"), button(context, MORE_ID, ACTION_ADD, step))
                    .addAction(0, str(rest, "skipLabel", "Skip"), button(context, SKIP_ID, ACTION_SKIP, 0));
            builder.getExtras().putBoolean("android.requestPromotedOngoing", true);
            if ("samsung".equalsIgnoreCase(Build.MANUFACTURER)) {
                // One UI shows the chip only for apps on Samsung's own list, unless the
                // notification carries this undocumented extra (One UI 8.5 SystemUI:
                // NotificationEntry.isAutomation). Never add android.ongoingActivityNoti.style
                // too: it moves the notification to Samsung's private card and undoes this.
                builder.getExtras().putBoolean("android.ongoingActivityNoti.automation", true);
                builder.getExtras().putString("android.ongoingActivityNoti.automationPackage", context.getPackageName());
            }

            manager.notify(NOTIFICATION_ID, builder.build());
            return null;
        } catch (SecurityException e) {
            // The permission went away between the check and the post.
            return "notifications-off";
        } catch (Exception e) {
            return e.getClass().getSimpleName() + ": " + e.getMessage();
        }
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

    private static PendingIntent button(Context context, int requestCode, String action, int seconds) {
        Intent intent = new Intent(context, RestTimerReceiver.class).setAction(action).putExtra(EXTRA_SECONDS, seconds);
        return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent openApp(Context context) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        return launch == null ? null : PendingIntent.getActivity(
                context, NOTIFICATION_ID, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // ---- the alert at the end ----

    // Due to the second: USE_EXACT_ALARM in the manifest grants exact alarms at install. Where
    // they are refused anyway, an inexact one still rings, a little late.
    private static String scheduleAlert(Context context, JSONObject rest) {
        try {
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            Intent intent = new Intent(context, RestTimerReceiver.class).setAction(ACTION_ALERT)
                    .putExtra("key", str(rest, "key", ""))
                    .putExtra("title", str(rest, "alertTitle", "Rest over"))
                    .putExtra("text", str(rest, "alertText", ""))
                    .putExtra("channelName", str(rest, "alertChannelName", "Rest over"));
            // One alarm at a time: the same request code and action replace the one before.
            PendingIntent pending = PendingIntent.getBroadcast(context, ALERT_ID, intent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            long at = rest.optLong("endsAt", 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarms.canScheduleExactAlarms()) {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } else {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            }
            return null;
        } catch (Exception e) {
            return e.getClass().getSimpleName() + ": " + e.getMessage();
        }
    }

    // The alarm, and the alert if it already rang.
    private static void cancelAlert(Context context) {
        try {
            PendingIntent pending = alarm(context);
            if (pending != null) {
                ((AlarmManager) context.getSystemService(Context.ALARM_SERVICE)).cancel(pending);
                pending.cancel();
            }
            NotificationManagerCompat.from(context).cancel(ALERT_ID);
        } catch (Exception e) {
            // Nothing to cancel.
        }
    }

    // The pending alarm, or null when none is set. Extras play no part in matching.
    static PendingIntent alarm(Context context) {
        Intent intent = new Intent(context, RestTimerReceiver.class).setAction(ACTION_ALERT);
        return PendingIntent.getBroadcast(context, ALERT_ID, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_NO_CREATE);
    }

    /** The alarm went off: ring the alert, and let the countdown go if it is still this rest's. */
    @SuppressLint("MissingPermission")
    static void ring(Context context, Intent intent) {
        PendingIntent pending = alarm(context);
        if (pending != null) pending.cancel();
        String key = intent.getStringExtra("key");
        JSONObject rest = load(context);
        if (rest != null && str(rest, "key", "").equals(key == null ? "" : key)) {
            forget(context);
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager system = context.getSystemService(NotificationManager.class);
            // Left as it is when it exists: importance and sound are the user's to change.
            if (system.getNotificationChannel(ALERT_CHANNEL_ID) == null) {
                String name = intent.getStringExtra("channelName");
                NotificationChannel channel = new NotificationChannel(ALERT_CHANNEL_ID, name == null ? "Rest over" : name, NotificationManager.IMPORTANCE_HIGH);
                channel.enableVibration(true);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                system.createNotificationChannel(channel);
            }
        }
        String title = intent.getStringExtra("title");
        String text = intent.getStringExtra("text");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_opengym)
                .setContentTitle(title == null ? "Rest over" : title)
                .setContentText(text == null ? "" : text)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                // Before Android 8 there are no channels: the notification itself asks for the sound.
                .setDefaults(NotificationCompat.DEFAULT_SOUND)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(openApp(context));
        manager.notify(ALERT_ID, builder.build());
    }
}
