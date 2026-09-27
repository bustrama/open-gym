package ch.duartesantos.opengym;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import org.json.JSONObject;

/**
 * The app's side of the rest on the status bar and the lock screen (RestTimer): the countdown
 * with its −15s, +15s and Skip buttons, and the alert at the end. A button tapped while the app
 * is running comes back as a "restChange" event: { key, endsAt } after −15s / +15s, { key,
 * skipped: true } after Skip, `key` being the one the app started the rest with. An event with
 * nobody listening yet is held until someone does.
 *
 * start() answers { shown, reason?, alertError? } instead of failing quietly, and status() says
 * what Android actually has up, so the app can tell the user why nothing appears.
 *
 * Usage from JS:
 *   import { registerPlugin } from '@capacitor/core';
 *   const RestTimer = registerPlugin('RestTimer');
 *   await RestTimer.start({ key, endsAt, title, text, channelName, alertTitle, alertText,
 *     alertChannelName, step, lessLabel, moreLabel, skipLabel }); // { shown, reason?, alertError? }
 *   await RestTimer.addListener('restChange', change => ...);
 *   await RestTimer.status();   // { enabled, channel, active, promotable, promoted, canPromote, sdk, rest, alarm }
 *   await RestTimer.stop({ keepAlert });
 */
@CapacitorPlugin(name = "RestTimer")
public class RestTimerPlugin extends Plugin {

    // The instance the running app talks to, for the receiver; none while no app is up.
    private static WeakReference<RestTimerPlugin> live = new WeakReference<>(null);

    @Override
    public void load() {
        live = new WeakReference<>(this);
    }

    @Override
    protected void handleOnDestroy() {
        if (live.get() == this) live.clear();
    }

    // A button changed the rest: tell the app, if one is running. Without one there is no rest
    // on its screen to change either.
    static void emit(JSObject change) {
        RestTimerPlugin plugin = live.get();
        if (plugin != null) plugin.notifyListeners("restChange", change, true);
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSObject rest = call.getData();
        // optLong takes the number whichever way the bridge parsed it (int, long or double).
        if (rest.optLong("endsAt", 0) <= 0) {
            call.reject("endsAt is required");
            return;
        }
        // An exception thrown out of a plugin method takes the whole app down (Capacitor
        // rethrows it), so everything below reports back instead.
        try {
            call.resolve(RestTimer.start(getContext(), rest));
        } catch (Exception e) {
            JSObject out = new JSObject();
            out.put("shown", false);
            out.put("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
            call.resolve(out);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            RestTimer.stop(getContext(), call.getBoolean("keepAlert", false));
        } catch (Exception e) {
            // Nothing up, or nothing to cancel it with: either way nothing is showing.
        }
        call.resolve();
    }

    // What Android has: notifications allowed, the channel's importance (-1 before the first
    // rest creates it), whether the countdown is up right now and whether Android 16 promoted
    // it, plus the rest this side keeps for the buttons and whether its alarm is set.
    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("sdk", Build.VERSION.SDK_INT);
        try {
            Context context = getContext();
            out.put("enabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
            NotificationManager system = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = system.getNotificationChannel(RestTimer.CHANNEL_ID);
                out.put("channel", channel == null ? -1 : channel.getImportance());
            }
            boolean active = false;
            for (StatusBarNotification sbn : system.getActiveNotifications()) {
                if (sbn.getId() != RestTimer.NOTIFICATION_ID) continue;
                active = true;
                Notification n = sbn.getNotification();
                out.put("actions", n.actions == null ? 0 : n.actions.length);
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
            JSONObject rest = RestTimer.load(context);
            if (rest != null) {
                JSObject kept = new JSObject();
                kept.put("key", RestTimer.str(rest, "key", ""));
                kept.put("endsAt", rest.optLong("endsAt", 0));
                out.put("rest", kept);
            }
            out.put("alarm", RestTimer.alarm(context) != null);
        } catch (Exception e) {
            out.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        call.resolve(out);
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
}
