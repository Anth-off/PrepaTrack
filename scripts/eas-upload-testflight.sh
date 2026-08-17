#!/usr/bin/env bash
set -euo pipefail

# Direct fallback that bypasses EAS Submit. It is enabled only by the
# production-testflight profile and runs on the Mac that signed the IPA.
if [[ "${EAS_BUILD_PLATFORM:-}" != "ios" || "${DIRECT_TESTFLIGHT_UPLOAD:-}" != "1" ]]; then
  exit 0
fi

: "${PREPATRACK_ASC_API_KEY_FILE:?Missing App Store Connect key file}"
: "${PREPATRACK_ASC_API_KEY_ID:?Missing App Store Connect key ID}"
: "${PREPATRACK_ASC_API_KEY_ISSUER:?Missing App Store Connect issuer ID}"

ipa_path="$(find ios/build -maxdepth 2 -type f -name '*.ipa' -print -quit)"
if [[ -z "$ipa_path" || ! -s "$ipa_path" ]]; then
  echo "::error::Signed IPA not found after EAS build."
  exit 1
fi

key_dir="$HOME/.appstoreconnect/private_keys"
key_path="$key_dir/AuthKey_${PREPATRACK_ASC_API_KEY_ID}.p8"
mkdir -p "$key_dir"
cp "$PREPATRACK_ASC_API_KEY_FILE" "$key_path"
chmod 600 "$key_path"
trap 'rm -f "$key_path"' EXIT

echo "Uploading IPA directly to App Store Connect..."
xcrun altool \
  --upload-app \
  --file "$ipa_path" \
  --type ios \
  --apiKey "$PREPATRACK_ASC_API_KEY_ID" \
  --apiIssuer "$PREPATRACK_ASC_API_KEY_ISSUER" \
  --output-format json
