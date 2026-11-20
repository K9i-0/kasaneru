// Launch the browser used for drawing.
// The default is the installed Google Chrome. The environment variable KASANERU_BROWSER can give the path to an executable or
// a Playwright channel name (chrome / chrome-beta / msedge / chromium and so on).
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';

export async function launchBrowser() {
  const choice = process.env.KASANERU_BROWSER ?? 'chrome';
  const options = existsSync(choice) ? {executablePath: choice} : choice === 'chromium' ? {} : {channel: choice};
  try {
    return await chromium.launch({...options, headless: true});
  } catch (e) {
    throw new Error(`Cannot launch the browser (${choice}). Install Google Chrome, or set KASANERU_BROWSER to the path of an executable.\n${e.message.split('\n')[0]}`);
  }
}
