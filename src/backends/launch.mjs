// 描画に使うブラウザを起動する。
// 既定は入っているGoogle Chrome。環境変数 KASANERU_BROWSER で、実行ファイルのパスか
// Playwrightのチャンネル名（chrome / chrome-beta / msedge / chromium など）を指定できる。
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';

export async function launchBrowser() {
  const choice = process.env.KASANERU_BROWSER ?? 'chrome';
  const options = existsSync(choice) ? {executablePath: choice} : choice === 'chromium' ? {} : {channel: choice};
  try {
    return await chromium.launch({...options, headless: true});
  } catch (e) {
    throw new Error(`ブラウザを起動できません（${choice}）。Google Chromeを入れるか、KASANERU_BROWSER に実行ファイルのパスを指定してください。\n${e.message.split('\n')[0]}`);
  }
}
