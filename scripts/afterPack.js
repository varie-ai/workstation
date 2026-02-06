/**
 * electron-builder afterPack hook
 *
 * Re-signs the speech-recognizer native binary with the correct entitlements
 * for microphone access. The extraResources binaries don't inherit the app's
 * entitlements automatically.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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

  const speechRecognizerPath = path.join(
    appPath,
    'Contents/Resources/native/macos/speech-recognizer'
  );

  const entitlementsPath = path.join(context.packager.projectDir, 'entitlements.mac.plist');

  // Check if speech-recognizer exists
  if (!fs.existsSync(speechRecognizerPath)) {
    console.log('[afterPack] speech-recognizer not found, skipping re-sign');
    return;
  }

  // Check if entitlements file exists
  if (!fs.existsSync(entitlementsPath)) {
    console.log('[afterPack] entitlements.mac.plist not found, skipping re-sign');
    return;
  }

  console.log('[afterPack] Re-signing speech-recognizer with entitlements...');
  console.log(`  Binary: ${speechRecognizerPath}`);
  console.log(`  Entitlements: ${entitlementsPath}`);

  try {
    // Re-sign with entitlements
    // Using ad-hoc signing (-) for local development
    // For distribution, use proper signing identity
    const signingIdentity = process.env.CSC_NAME || '-';

    execSync(
      `codesign --force --options runtime --entitlements "${entitlementsPath}" --sign "${signingIdentity}" "${speechRecognizerPath}"`,
      { stdio: 'inherit' }
    );

    console.log('[afterPack] speech-recognizer re-signed successfully');

    // Verify
    const result = execSync(
      `codesign -d --entitlements - "${speechRecognizerPath}" 2>&1`,
      { encoding: 'utf8' }
    );

    if (result.includes('com.apple.security.device.audio-input')) {
      console.log('[afterPack] Verified: audio-input entitlement present');
    } else {
      console.warn('[afterPack] Warning: audio-input entitlement not found in verification');
    }
  } catch (error) {
    console.error('[afterPack] Failed to re-sign speech-recognizer:', error.message);
    // Don't fail the build, but warn
  }
};
