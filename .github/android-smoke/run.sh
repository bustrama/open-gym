#!/usr/bin/env bash
# Runs inside the emulator job: installs the debug APK, starts a real rest in a workout, and taps
# the countdown notification's −15s / +15s / Skip buttons from the shade: with the app in front,
# in the background, and with its process gone. Records what the app and the system then have.
# Everything lands in $OUT.
set -x
OUT=smoke-out
mkdir -p $OUT
PKG=ch.duartesantos.opengym.test
PROBE="node .github/android-smoke/probe.mjs"
APK=frontend/android/app/build/outputs/apk/debug/app-debug.apk
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
notif() { adb shell dumpsys notification --noredact > "$OUT/$1.txt"; grep -n -A40 "NotificationRecord.*pkg=$PKG.*id=$2" "$OUT/$1.txt" | grep -E "NotificationRecord|when=|actions=|  \[[0-9]\] \"|channel=|importance" | head -12; }
alarm() { adb shell dumpsys alarm > "$OUT/$1.txt"; grep -n -B2 -A6 "$PKG" "$OUT/$1.txt" | grep -E "REST_ALERT|origWhen|when=|type=" | head -8; }
# Taps the node whose resource-id or text matches, from a uiautomator dump.
tap_ui() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null
  adb shell cat /sdcard/ui.xml > $OUT/ui-$2.xml
  B=$(grep -o "<node[^>]*\($1\)[^>]*>" $OUT/ui-$2.xml | head -1 | grep -o 'bounds="[^"]*"' | grep -o '[0-9]\+')
  set -- $B
  if [ -n "$4" ]; then adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 )); echo "tapped $1,$2"; else echo "NOT FOUND"; fi
}
shade() { adb shell cmd statusbar expand-notifications; sleep 2; }
collapse() { adb shell cmd statusbar collapse; sleep 1; }
forward() {
  PID=$(adb shell pidof $PKG | tr -d '\r')
  adb forward --remove-all
  adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
}
timer() { $PROBE '__timer()'; }
status() { $PROBE 'Capacitor.nativePromise("RestTimer", "status", {})'; }

adb shell getprop ro.build.version.release
adb install -r -g "$APK"
adb logcat -c
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 15
forward

# Local mode, the rest notifications on, a 60-second rest, and a workout under way.
$PROBE '__clickText("Use on this device")'
sleep 3
$PROBE '__seedWorkout()'
sleep 5
forward
$PROBE 'location.hash = "#/workout"'
sleep 3
$PROBE '__listen()'
shot 01-workout

# 1. A set ticked: the rest starts, with its countdown and three buttons.
$PROBE '__tick()'
sleep 3
timer
status
notif 02-countdown 7100
alarm 02-alarm
shot 02-rest-started

# 2. +15s from the shade, the app in front.
shade
shot 03-shade
tap_ui 'text="+15s"' 03
sleep 2
collapse
timer
$PROBE 'window.__changes'
status
notif 04-after-plus 7100
alarm 04-alarm

# 3. −15s the same way.
shade
tap_ui 'text="−15s"' 05
sleep 2
collapse
timer
$PROBE 'window.__changes'
status

# 4. The app in the background: +15s, then back to the app.
adb shell input keyevent KEYCODE_HOME
sleep 2
shade
tap_ui 'text="+15s"' 06
sleep 2
collapse
status
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 3
timer
$PROBE 'window.__changes'
shot 07-back-in-app

# 5. The lock screen: +15s on the keyguard without unlocking.
adb shell input keyevent KEYCODE_SLEEP
sleep 2
adb shell input keyevent KEYCODE_WAKEUP
sleep 2
shot 08-keyguard
tap_ui 'text="+15s"' 08
sleep 2
shot 09-keyguard-after
status
adb shell wm dismiss-keyguard
adb shell input keyevent 82
sleep 2
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 2
timer

# 6. Skip from the shade: the rest ends in the app, countdown and alarm gone.
shade
tap_ui 'text="Skip"' 10
sleep 2
collapse
timer
$PROBE 'window.__changes'
status
alarm 11-alarm-after-skip
shot 11-after-skip

# 7. No app process: a new rest, the app sent home and killed, +15s tapped. The receiver runs in
#    a process of its own and moves the countdown and the alarm.
$PROBE "__tick()"
sleep 3
status
notif 12-before-kill 7100
adb shell input keyevent KEYCODE_HOME
sleep 2
adb shell am kill $PKG
sleep 2
adb shell pidof $PKG || echo "no process"
shade
tap_ui 'text="+15s"' 13
sleep 3
collapse
adb shell pidof $PKG || echo "no process"
notif 13-after-kill-plus 7100
alarm 13-alarm

# 8. Let that rest run out unwatched: the alert rings on rest-over.
sleep 90
notif 14-alert 7101
shot 14-alert

adb logcat -d > $OUT/logcat.txt
grep -i -E "RestTimer|AndroidRuntime|FATAL|Capacitor/Console" $OUT/logcat.txt | tail -60
exit 0
