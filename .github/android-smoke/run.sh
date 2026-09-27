#!/usr/bin/env bash
# Runs inside the emulator job: installs the debug APK, calls the rest-timer plugins from the
# WebView, and records what the system actually posted. Everything lands in $OUT.
set -x
OUT=smoke-out
mkdir -p $OUT
PKG=ch.duartesantos.opengym.test
PROBE="node .github/android-smoke/probe.mjs"
APK=frontend/android/app/build/outputs/apk/debug/app-debug.apk

adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.version.release
adb install -r -g "$APK"
adb shell dumpsys package $PKG | grep -E "POST_NOTIFICATIONS|POST_PROMOTED|USE_EXACT_ALARM|targetSdk" | head
adb logcat -c
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 20
PID=$(adb shell pidof $PKG | tr -d '\r')
echo "pid=$PID"
adb shell cat /proc/net/unix | grep -i devtools
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9222/json | tee $OUT/pages.json

$PROBE 'Capacitor.getPlatform()'
$PROBE '(window.Capacitor.PluginHeaders||[]).map(p => p.name + ":" + p.methods.map(m => m.name).join(","))'
$PROBE 'Capacitor.nativePromise("LocalNotifications", "checkPermissions", {})'

# 1. The countdown, exactly as rest-notify.js calls it.
$PROBE 'Capacitor.nativePromise("RestTimer", "start", { endsAt: Date.now() + 120000, title: "Rest", text: "Bench Press", channelName: "Rest timer" })'
sleep 3
adb exec-out screencap -p > $OUT/1-statusbar.png
adb shell dumpsys notification --noredact > $OUT/dumpsys-1.txt
grep -n -B2 -A45 "pkg=$PKG" $OUT/dumpsys-1.txt | head -120
adb shell cmd notification list 2>&1 | grep -i opengym
adb shell cmd statusbar expand-notifications
sleep 3
adb exec-out screencap -p > $OUT/2-shade.png
adb shell cmd statusbar collapse

# 2. The alert at the end, as rest-notify.js schedules it (8 s out instead of the rest's end).
$PROBE 'Capacitor.nativePromise("LocalNotifications", "createChannel", { id: "rest-over", name: "Rest over", importance: 5, visibility: 1, vibration: true })'
$PROBE 'Capacitor.nativePromise("LocalNotifications", "schedule", { notifications: [{ id: 7101, title: "Rest over — next set!", body: "Bench Press", channelId: "rest-over", smallIcon: "ic_stat_opengym", autoCancel: true, schedule: { at: new Date(Date.now() + 8000), allowWhileIdle: true } }] })'
$PROBE 'Capacitor.nativePromise("LocalNotifications", "getPending", {})'
sleep 14
adb exec-out screencap -p > $OUT/3-alert.png
adb shell dumpsys notification --noredact > $OUT/dumpsys-2.txt
grep -n "pkg=$PKG" $OUT/dumpsys-2.txt
grep -n -A12 "mChannels\|NotificationChannel{mId='rest" $OUT/dumpsys-2.txt | grep -i -A3 "rest-" | head -40

# 3. Stop.
$PROBE 'Capacitor.nativePromise("RestTimer", "stop", {})'
sleep 2
adb shell dumpsys notification --noredact | grep -c "pkg=$PKG"

adb logcat -d > $OUT/logcat.txt
grep -i -E "RestTimer|Capacitor|AndroidRuntime|FATAL|notif.*opengym|opengym.*notif" $OUT/logcat.txt | tail -80
exit 0
