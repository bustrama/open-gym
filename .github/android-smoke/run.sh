#!/usr/bin/env bash
# Runs inside the emulator job: installs the debug APK, starts a real rest in a workout, and taps
# the countdown notification's −15s / +15s / Skip buttons from the shade: with the app in front,
# in the background, with its process gone, and on a PIN lock screen. Records what the app and
# the system then have. Everything lands in $OUT.
set -x
OUT=smoke-out
mkdir -p $OUT
PKG=ch.duartesantos.opengym.test
PROBE="node .github/android-smoke/probe.mjs"
APK=frontend/android/app/build/outputs/apk/debug/app-debug.apk
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
notif() { adb shell dumpsys notification --noredact > "$OUT/$1.txt"; grep -n -A40 "NotificationRecord.*pkg=$PKG.*id=$2" "$OUT/$1.txt" | grep -E "NotificationRecord|when=|actions=|  \[[0-9]\] \"|channel=|importance" | head -12; }
alarm() { adb shell dumpsys alarm > "$OUT/$1.txt"; grep -n -A2 "origWhen.*$PKG" "$OUT/$1.txt" | grep -E "origWhen" | head -4; }
# uiautomator cannot dump the shade while a chronometer ticks (it never goes idle), so the
# buttons are tapped where the 320x640 emulator draws them, our notification being the first.
BY=344
tap_less() { adb shell input tap 83 $BY; }
tap_more() { adb shell input tap 143 $BY; }
tap_skip() { adb shell input tap 199 $BY; }
shade() { adb shell cmd statusbar expand-notifications; sleep 2; }
collapse() { adb shell cmd statusbar collapse; sleep 1; }
forward() {
  PID=$(adb shell pidof $PKG | tr -d '\r')
  adb forward --remove-all
  adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
}
timer() { $PROBE '__timer()'; }
status() { $PROBE 'Capacitor.nativePromise("RestTimer", "status", {}).then(s => ({ active: s.active, actions: s.actions, rest: s.rest, alarm: s.alarm }))'; }
changes() { $PROBE 'window.__changes'; }
# A rest straight from the plugin, for the steps without the app: seconds from now.
plugin_rest() { $PROBE "Capacitor.nativePromise('RestTimer', 'start', { key: '$1', endsAt: Date.now() + $2 * 1000, title: 'Rest', text: 'Plugin rest', alertTitle: 'Rest over', step: 15, lessLabel: '−15s', moreLabel: '+15s', skipLabel: 'Skip' })"; }

adb shell getprop ro.build.version.release
adb install -r -g "$APK"
adb logcat -c
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 15
forward

# Local mode, the rest notifications on, a 3-minute rest, and a workout under way.
$PROBE '__clickText("Use on this device")'
sleep 3
$PROBE '__seedWorkout()'
sleep 5
forward
$PROBE 'location.hash = "#/workout"'
sleep 3
$PROBE '__listen()'

echo "=== 1. a set ticked: the rest starts"
$PROBE '__tick()'
sleep 2
timer
status
notif 01-countdown 7100
alarm 01-alarm

echo "=== 2. +15s from the shade, the app in front"
shade
shot 02-shade
tap_more
sleep 2
shot 02-shade-after
collapse
timer
changes
status
notif 02-after-plus 7100
alarm 02-alarm

echo "=== 3. -15s the same way"
shade
tap_less
sleep 2
collapse
timer
changes
status

echo "=== 4. the app in the background: +15s, then back to the app"
adb shell input keyevent KEYCODE_HOME
sleep 2
shade
tap_more
sleep 2
collapse
status
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 2
timer
changes
shot 04-back-in-app

echo "=== 5. Skip from the shade: the rest ends in the app, countdown and alarm gone"
shade
tap_skip
sleep 2
collapse
timer
changes
status
alarm 05-alarm-after-skip
shot 05-after-skip

echo "=== 6. -15s with less than 15s left ends the rest"
$PROBE '__tick()'
sleep 2
timer
# Only the tick's rest has the app's key; move the phone's copy to 10 seconds from now by hand.
$PROBE 'Capacitor.nativePromise("RestTimer", "status", {}).then(s => Capacitor.nativePromise("RestTimer", "start", { key: s.rest.key, endsAt: Date.now() + 10000, title: "Rest", step: 15, lessLabel: "−15s", moreLabel: "+15s", skipLabel: "Skip" }))'
shade
tap_less
sleep 2
collapse
changes
status
timer

echo "=== 7. no app process: the countdown up, the app sent home and killed, +15s tapped"
plugin_rest k7 40
sleep 1
status
notif 07-before-kill 7100
alarm 07-alarm-before
adb shell input keyevent KEYCODE_HOME
sleep 2
adb shell am kill $PKG
sleep 2
adb shell pidof $PKG || echo "no process"
shade
tap_more
sleep 3
collapse
adb shell pidof $PKG || echo "no process"
notif 07-after-kill-plus 7100
alarm 07-alarm-after

echo "=== 8. that rest runs out unwatched: the alert rings on rest-over"
sleep 60
notif 08-alert 7101
shot 08-alert

echo "=== 9. a PIN lock screen: the countdown's buttons there"
adb shell am start -W -n $PKG/ch.duartesantos.opengym.MainActivity
sleep 5
forward
plugin_rest k9 120
sleep 1
adb shell locksettings set-pin 1234
adb shell input keyevent KEYCODE_SLEEP
sleep 2
adb shell input keyevent KEYCODE_WAKEUP
sleep 2
shot 09-keyguard
adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml > $OUT/09-keyguard.xml
adb shell dumpsys window | grep -E "mDreamingLockscreen|isKeyguardShowing|mShowingLockscreen|KeyguardController" | head -5

adb logcat -d > $OUT/logcat.txt
grep -E "FATAL EXCEPTION" -A2 $OUT/logcat.txt | head -20
grep -i -E "RestTimer" $OUT/logcat.txt | grep -v "Capacitor/Plugin\|callback:" | tail -20
exit 0
