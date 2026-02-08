/**
 * electron-builder afterPack hook
 *
 * Re-signs native binaries with the correct entitlements for microphone access.
 * The extraResources binaries don't inherit the app's entitlements automatically.
 *
 * Binaries signed:
 * - speech-recognizer (Apple Speech API)
 * - whisperkit-recognizer (WhisperKit local Whisper STT)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Re-sign a native binary with entitlements.
 * Returns true on success, false on failure (non-fatal).
 */
function signBinary(binaryPath, entitlementsPath, signingIdentity, label) {
  if (!fs.existsSync(binaryPath)) {
    console.log(`[afterPack] ${label} not found, skipping`);
    return false;
  }

  console.log(`[afterPack] Re-signing ${label}...`);
  console.log(`  Binary: ${binaryPath}`);

  try {
    execSync(
      `codesign --force --options runtime --entitlements "${entitlementsPath}" --sign "${signingIdentity}" "${binaryPath}"`,
      { stdio: 'inherit' }
    );

    console.log(`[afterPack] ${label} re-signed successfully`);

    // Verify audio-input entitlement
    const result = execSync(
      `codesign -d --entitlements - "${binaryPath}" 2>&1`,
      { encoding: 'utf8' }
    );

    if (result.includes('com.apple.security.device.audio-input')) {
      console.log(`[afterPack] Verified: ${label} has audio-input entitlement`);
    } else {
      console.warn(`[afterPack] Warning: ${label} missing audio-input entitlement`);
    }
    return true;
  } catch (error) {
    console.error(`[afterPack] Failed to re-sign ${label}:`, error.message);
    return false;
  }
}

exports.default = async function afterPack(context) {
  // Only run on macOS
  if (process.platform !== 'darwin') {
    console.log('[afterPack] Skipping - not macOS');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  const entitlementsPath = path.join(context.packager.projectDir, 'entitlements.mac.plist');

  if (!fs.existsSync(entitlementsPath)) {
    console.log('[afterPack] entitlements.mac.plist not found, skipping re-sign');
    return;
  }

  const signingIdentity = process.env.CSC_NAME || '-';

  // Sign all native binaries that need microphone access
  const binaries = [
    {
      path: path.join(appPath, 'Contents/Resources/native/macos/speech-recognizer'),
      label: 'speech-recognizer',
    },
    {
      path: path.join(appPath, 'Contents/Resources/native/macos/whisperkit-recognizer'),
      label: 'whisperkit-recognizer',
    },
  ];

  let signed = 0;
  for (const bin of binaries) {
    if (signBinary(bin.path, entitlementsPath, signingIdentity, bin.label)) {
      signed++;
    }
  }

  console.log(`[afterPack] Signed ${signed}/${binaries.length} native binaries`);
};
