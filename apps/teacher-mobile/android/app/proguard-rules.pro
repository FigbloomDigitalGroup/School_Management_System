# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# React Native's new-architecture (Fabric) classes are accessed via reflection
# by native modules (e.g. react-native-screens); R8 renaming their fields
# crashes with NoSuchFieldError at startup if they aren't kept.
-keep class com.facebook.react.fabric.** { *; }
-keepclassmembers class com.facebook.react.fabric.** { *; }
-dontwarn com.facebook.react.fabric.**
