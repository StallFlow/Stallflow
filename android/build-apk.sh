#!/usr/bin/env bash
# Builds the Android app (android/) into the given .apk path.
# Signed with the ANDROID_KEYSTORE_B64 / ANDROID_KEYSTORE_PASSWORD secrets when
# they are set, so every build can update the one already installed. Without
# them it signs with a throwaway key: fine to try, but each such build has to
# be uninstalled before the next is installed.
set -euo pipefail
out="$(realpath -m "$1")"
cd "$(dirname "$0")"
if [ -n "${ANDROID_KEYSTORE_B64:-}" ]; then
  echo "$ANDROID_KEYSTORE_B64" | base64 -d > release.keystore
  export KEYSTORE_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
else
  echo "::warning::No ANDROID_KEYSTORE_B64 secret: signing with a throwaway key."
  export KEYSTORE_PASSWORD="throwaway-$(date +%s)"
  keytool -genkeypair -keystore release.keystore -alias stallflow -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" \
    -dname "CN=StallFlow test" -noprompt
fi
export KEYSTORE="$PWD/release.keystore"
count="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
gradle --no-daemon -q assembleRelease -PversionCode="$count" -PversionName="1.$count"
cp app/build/outputs/apk/release/app-release.apk "$out"
rm -f release.keystore
echo "built $out"
