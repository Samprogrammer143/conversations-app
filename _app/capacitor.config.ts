// The Android app (android/): Capacitor wraps the phone build (dist-phone, from
// vite.phone.config.ts) in a WebView. Build: npm run phone:apk.
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.samcan.conversations",
  appName: "Conversations",
  webDir: "dist-phone",
  android: { allowMixedContent: false },
  plugins: {
    // github.com's sign-in endpoints don't take browser requests (CORS): fetch goes through the native HTTP client.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
