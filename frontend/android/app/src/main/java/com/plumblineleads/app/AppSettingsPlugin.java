package com.plumblineleads.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Minimal bridge with a single job: open THIS app's App Info page
 * (Settings → Apps → Plumbline Leads) so the user can flip the Microphone
 * permission — the only recovery path after "Don't ask again".
 *
 * ACTION_APPLICATION_DETAILS_SETTINGS with a package: URI deep-links
 * straight to the app-specific page; we never fall back to the general
 * Settings root. getPackageName() keeps it correct across applicationId
 * variants (debug suffixes etc.) instead of hardcoding com.plumblineleads.app.
 *
 * Launched from the ACTIVITY, deliberately without FLAG_ACTIVITY_NEW_TASK:
 * App Info then opens inside our own task, so the system Back button returns
 * the user straight to Plumbline Leads and the resume-time microphone
 * re-check runs. NEW_TASK would strand App Info in a separate task and Back
 * would drop the user on the home screen instead.
 *
 * Failures reject with an internal diagnostic string. The web layer never
 * renders that text — it shows its own friendly fallback message.
 */
@CapacitorPlugin(name = "AppSettings")
public class AppSettingsPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            call.reject("No active Activity available to launch App Info");
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", activity.getPackageName(), null));
            activity.startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Unable to open App Info: " + e.getMessage(), e);
        }
    }
}
