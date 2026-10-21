package com.figbloom.schools

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  // FIG-782: the manifest launches this Activity with SplashTheme so the
  // branded splash_background is the very first thing drawn; swap back to
  // the real AppTheme here, before the window's content is set, so the
  // splash only covers the cold-start gap.
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    // react-native-screens requires this: Screen/ScreenStack fragments must
    // never be restored from a saved Activity state (their no-arg
    // constructors throw IllegalStateException by design), so Activity
    // re-creation (process death in the background, or a font/display-size
    // or language config change) must always start from a clean slate.
    super.onCreate(null)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Figbloom"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
