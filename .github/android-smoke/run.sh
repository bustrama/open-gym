#!/usr/bin/env bash
# Runs inside the emulator job: installs the debug APK and walks the rest timer the way a user
# does (onboarding, Settings, the switch and its permission dialog, the test rest), recording
# what the system actually posted. Everything lands in $OUT.
set -x
OUT=smoke-out
mkdir -p $OUT
PKG=ch.duartesantos.opengym.test
PROBE="node .github/android-smoke/probe.mjs"
APK=frontend/android/app/build/outputs/apk/debug/app-debug.apk
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
notifs() { adb shell dumpsys notification --noredact > "$OUT/$1.txt"; grep -n "NotificationRecord.*pkg=$PKG" "$OUT/$1.txt"; }
# Taps the button whose resource-id or text matches, from a uiautomator dump.
tap_ui() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null
  adb shell cat /sdcard/ui.xml > $OUT/ui.xml
  B=$(grep -o "<node[^>]*\($1\)[^>]*>" $OUT/ui.xml | head -1 | grep -o 'bounds="[^"]*"' | grep -o '[0-9]\+')
  set -- $B
  [ -n "$4" ] && adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}

adb shell getprop ro.build.version.release
# No -g: the switch has to ask for the notification permission, as it did on the phone.
adb install -r "$APK"
adb logcat -c
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 15
PID=$(adb shell pidof $PKG | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID

# Onboarding: local mode.
$PROBE '__clickText("Use on this device")'
sleep 3
shot 01-after-onboarding
$PROBE 'location.hash = "#/settings"'
sleep 3
$PROBE '__rowChecked("Counts down on the lock screen")'
shot 02-settings

# The switch: Android asks for the permission; allow it.
$PROBE '__rowSwitch("Counts down on the lock screen")'
sleep 3
shot 03-permission-dialog
tap_ui 'permission_allow_button\|text="Allow"'
sleep 3
shot 04-after-allow
$PROBE '__rowChecked("Counts down on the lock screen")'
$PROBE '__state().restNotify'
adb shell dumpsys package $PKG | grep -E "POST_NOTIFICATIONS: granted"

# The test rest.
$PROBE '__rowClick("Test the rest timer")'
sleep 3
$PROBE 'document.body.innerText.split("\n").filter(l => /Test rest|could not|turned off/.test(l))'
shot 05-test-rest-statusbar
notifs 06-dumpsys-countdown
grep -n -A30 "NotificationRecord.*pkg=$PKG.*id=7100" $OUT/06-dumpsys-countdown.txt | grep -E "NotificationRecord|flags=|importance|channel|requestPromoted" | head
$PROBE 'Capacitor.nativePromise("RestTimer", "status", {})'
adb shell cmd statusbar expand-notifications
sleep 2
shot 07-shade
adb shell cmd statusbar collapse
sleep 10
notifs 08-dumpsys-alert
shot 09-alert

# A longer countdown straight from the plugin, for the status it reports while up.
$PROBE 'Capacitor.nativePromise("RestTimer", "start", { endsAt: Date.now() + 90000, title: "Rest", text: "Bench Press", channelName: "Rest timer" })'
sleep 2
$PROBE 'Capacitor.nativePromise("RestTimer", "status", {})'
grep -n "NotificationChannel{mId='rest" $OUT/08-dumpsys-alert.txt | sed 's/mSound.*mVibrationEnabled/…mVibrationEnabled/' | head

adb logcat -d > $OUT/logcat.txt
grep -i -E "RestTimer|AndroidRuntime|FATAL|Capacitor/Console" $OUT/logcat.txt | tail -60
exit 0
