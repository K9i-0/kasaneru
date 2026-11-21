# kasaneru

[English](README.md)

manifest（JSON）から動画を書き出すツール。名前は「重ねる」から。層を重ねて動画を作る。

- 動画・音声の切り貼りと合成は `ffmpeg`（外部コマンド）
- 文字・図形・3Dは「描画バックエンド」が画像にして渡す。同じ絵になるコマは1回だけ描く
- 描画バックエンドは2種類。どちらも画面は出さない
  - `browser`: 手元のChromeをPlaywright経由で動かして撮る。HTML文字列、React、ページ内スクリプト（three.jsなど）を描ける
  - `flutter`: `flutter test` の中でウィジェットを `RepaintBoundary.toImage` で取り出す

動作を確かめているのはmacOSだけ。WindowsとLinuxでは動かしていない。

## 使い方

npmから入れる（`npx kasaneru` でそのまま実行もできる）:

```bash
npm install kasaneru
npx kasaneru check  manifest.json
npx kasaneru render manifest.json -o out.mp4
```

例はnpmのパッケージに入っていない。試すときはリポジトリをクローンする:

```bash
git clone https://github.com/K9i-0/kasaneru.git
cd kasaneru && npm install
node examples/basic/make-assets.mjs          # 例の素材をffmpegで作る（外部の素材は不要）
node bin/kasaneru.mjs check   examples/basic/manifest.json
node bin/kasaneru.mjs render  examples/basic/manifest.json -o out/basic.mp4
node bin/kasaneru.mjs still   examples/basic/manifest.json --frame 100 -o out/basic_100.png
node bin/kasaneru.mjs inspect out/basic.mp4
```

| コマンド | 内容 |
|---|---|
| `check <manifest>` | 書き出さずに、manifestの誤りを場所つきで全部挙げる（JSON。誤りがあれば終了コード1） |
| `render <manifest> -o <mp4>` | 書き出す。先に `check` と同じ検証をして、誤りがあれば書き出さない |
| `still <manifest> --frame N -o <png>` | 1コマだけ書き出す。その1コマに要る絵しか描かないので速い |
| `inspect <動画>` | 尺・コマ数・音量と、先頭コマが暗くないか・音が振り切れていないかを報告する |
| `inspect <動画> --deep` | 上に加えて、1コマだけ壊れた絵（真っ白・崩れ）を探す（`suspectFrames`）。先頭と最後のコマは片側としか比べられないので、隣と大きく違うときに弱い注意として挙げる（`edgeFrames`。カットとは区別できないので、見て確かめる） |
| `sheet <動画> -o <png>` | 確認用のコマ一覧を作る。`--frames 0,120,240`、`--every N`、`--manifest <manifest>`（クリップや字幕の切り替わりの前後を自動で選ぶ）、`--cols N`（列数、既定は4） |
| `srt <manifest> -o <srt>` | 字幕をSRTにする（`captions` の層から。`--key props.captions` で場所を指定もできる） |
| `captions <字幕ファイル> --fps N` | SRT・ASSを `[{from, to, text}]`（コマ数）のJSONにする |
| `probe <素材> [--fps N]` | 素材の長さ（コマ数）・大きさ・音声の有無を調べる |
| `envelope <音声> --fps N` | コマごとの音量を配列で出す（口パクなど） |
| `--help` / `--version` | 使い方・版を表示する。知らない指定を渡すと、どれが違うかと使い方を出して終了コード2で終わる |

`render` の主な指定:

- `--backend browser|flutter|none`（既定 `browser`。`none` は動画層だけ）
- 出力の形式は拡張子で決まる: `.mp4`（H.264）、`.mov`（ProRes 422 HQ）、`.webm`（VP9）、`.gif`
- `--frames A-B` は一部のコマだけ書き出す（確認用）
- `--props <ファイルかJSON>` と `--set 場所=値` は、manifestの `props` を差し替える（同じmanifestから文言違いなどの変種を作る）
- `--concurrency N` は同時に描くページ数（`browser`、既定4）
- `--encoder h264_videotoolbox` はmacのハードウェアエンコーダを使う
- `--crf N` は、既定のエンコーダでの `.mp4` と `.webm`（VP9の範囲に換算する）の画質（既定は18。小さいほど高画質でファイルが大きい）
- `--every-frame` は、同じ絵を1回だけ描くのをやめて全コマ分の絵を描く（確認用）
- `--audio-bitrate 256k` は音声のビットレートを変える（既定は `.mp4` が192k、`.webm` が160k。`.mov` は無圧縮なので効かない）
- `--allow-missing-assets` は、シーンの素材が読めなくても書き出す（下の「読めない素材」）
- `--keep-work` は作業用フォルダ（描いた絵とffmpegのフィルタ）を消さずに残す。`--work <dir>` で置き場所を指定できる（既定は出力の隣の `<出力名>.work`）

結果は、所要時間の内訳と注意点をJSONで標準出力へ返す。

### 読めない素材

`browser` で描くシーンの画像が読めないとき（ファイルがない・壊れている・読み込みが30秒で終わらない）は、絵を全部描いたあと、動画を作る前に失敗にする（終了コード1）。読めなかったURL・最初に気づいた層とコマ・何枚の絵で起きたかを標準エラーへ出す。

- 見ているもの: `<img>`（読み込み後の `naturalWidth` が0）と、ページが出した読み込みの失敗（CSSの背景画像、SVGの `<image>`、フォントなど）。`scenes.page` のシーンは、`ctx.assets` から読もうとしてなかったファイル
- `--allow-missing-assets` を付けると失敗にせず、結果のJSONの `warnings` に同じ内容を入れて書き出す
- 待つ長さは環境変数 `KASANERU_IMAGE_TIMEOUT_MS` で変えられる。一度時間切れした画像は、次の絵からは待たずに失敗として数える
- 読み込みの途中で取り消されたもの（次のコマで要らなくなった背景画像など）は、失敗に数えない
- `<img>` 以外は読み込みを待たずに撮っている。手元のファイルはすぐ読めるので実害は出ていないが、背景画像が撮影に間に合わない・失敗の報告が間に合わないことはありうる。確実に待たせたい画像は `<img>` で置く
- `scenes.page` のシーンで起きたページ内のエラー（`pageerror`）は、失敗にはせず `warnings` に入れる

### 必要なものと注意

必要なもの: Node 22、ffmpeg、Google Chrome（`browser`）、Flutter（`flutter`）。テストは `npm test`。

**信頼できるmanifestだけを描画すること。** manifestはシーンのファイル（`scenes.browser` `scenes.page` `scenes.flutter`）を指し、kasaneruはそれを実行する（手元のNodeのコードとして、ブラウザの中で、または `flutter test` の中で）。他人のmanifestを描画すると、その人のコードが自分の権限で動く。素材のパスも、manifestが指す場所からそのまま読む。

`flutter` は、生成したエントリポイントとビルドのキャッシュをkasaneru自身の `flutter_backend/` フォルダに書く。そのため、kasaneruを入れたフォルダに書き込める必要がある（ローカルの `npm install` なら書ける。root所有のシステム全体へのインストールでは書けない）。

ブラウザは環境変数 `KASANERU_BROWSER` で変えられる（実行ファイルのパスか、`chrome-beta` `msedge` `chromium` などの名前）。

## manifest

時刻はすべてコンポジションのfpsでのコマ数（整数）で書く。パスはmanifestの場所からの相対。

| 項目 | 内容 |
|---|---|
| `composition` | `width` `height` `fps` `durationInFrames`。`durationInFrames` を省くと、いちばん遅く終わるクリップ・音声に合わせる |
| `background` | 背景色（`#RRGGBB`） |
| `layers` | 下から順に重ねる層。`video` / `scene` / `captions` / `adjust` |
| `audio` | 音声トラックの配列 |
| `master` | 音声の仕上げ。`limiter`（上限、0〜1）と `loudnorm`（`i` `tp` `lra`） |
| `scenes` | シーンの場所。`browser`（HTML/React）、`page`（ページ内スクリプト）、`flutter`（Dartファイル） |
| `assets` | `page` のシーンから読む素材のフォルダ（省略時はmanifestのあるフォルダ）。ページに渡すのはこのフォルダの下のファイルだけで、外のファイルを読もうとすると「読めない素材」として失敗する |
| `fonts` | 読み込むフォントファイル（`family` `file`、必要なら `weight` `style`）。システムにないフォントを使うとき |
| `props` | シーンへ渡す値 |

### video層

`clips` にクリップを並べる。クリップが1つなら、層に直接 `src` などを書いてもよい。動画のほか、静止画（png・jpg・webp）と単色も置ける。透過つきの素材（透過PNGなど）は、透明な所で下の層が見える（題字を動画に重ねるなど）。

層に `"sequence": true` を書くと、クリップを順に並べる（`from` を自動で決め、長さは素材から読む）。`overlap` で前後を重ねられる（フェードと組み合わせるとクロスフェード）。

| クリップの指定 | 意味 |
|---|---|
| `src` | 動画か静止画 |
| `color` | `src` の代わりに書くと、その色で塗った絵になる（暗転・帯・色かぶせ） |
| `from` `durationInFrames` | 出す位置と長さ |
| `trimBefore` | 素材の頭を何コマ飛ばすか |
| `playbackRate` | 速度（2で倍速、0.5で半分） |
| `loop` | `true` で素材全体を繰り返す。数値なら、その長さ（コマ数）を繰り返す |
| `freeze` | 素材のそのコマで止める |
| `reverse` | 逆再生 |
| `crop` | 素材の一部を切り出す `{x, y, width, height}`（素材のpx）。`x` `y` はキーフレームにできる（縦動画化のパンなど） |
| `shake` | 揺れ `{amplitude, speed, from, durationInFrames, seed, decay}`。乱数を使わないので、何度書き出しても同じ絵になる |
| `fadeIn` `fadeOut` | 透明度のフェード（コマ数）。重なるクリップに使えばクロスフェードになる |
| `audioFadeIn` `audioFadeOut` | クリップ自身の音声のフェード（コマ数） |
| `volume` | 書くと、その動画の音声も同じ位置で鳴らす（数値かキーフレーム）。書かなければ無音。キーフレームのコマとモノラルの扱いは `audio` と同じ（クリップ先頭からではなく、動画全体のコマ番号） |

次の指定は、層に書けば全クリップに、クリップに書けばそのクリップだけに効く。

| 指定 | 意味 |
|---|---|
| `fit` | `cover`（はみ出しを切る、既定）/ `fill`（引き伸ばす）/ `contain`（全体を収め、余白は透明） |
| `align` | `cover` で切るときの寄せ位置 `[横, 縦]`（0〜1、既定は中央） |
| `flip` | 反転。`h`（左右）/ `v`（上下）/ `hv` |
| `filter` | CSSの `filter` と同じ書き方。`brightness()` `contrast()` `saturate()` `grayscale()` `sepia()` `invert()` `hue-rotate()` `blur()` `opacity()` を順にかける |
| `opacity` | 不透明度。数値か `{keyframes, easing}` |
| `blur` | ぼかし（CSSのblurと同じ単位） |
| `rotate` | 回転（度、時計回り）。数値か `{keyframes, easing}`。箱の中心で回り、はみ出した分は切れる |
| `radius` `mask` | 角丸（px）。`mask` は `"ellipse"` か白黒の画像（白い所が残る） |
| `chromaKey` | 指定した色を透明にする `{color, similarity, blend}`（グリーンバックなど） |
| `corners` | 四隅（左上・右上・左下・右下）の行き先を全体の座標で指定して、絵をはめ込む（画面の差し替えなど）。`{keyframes: [[コマ, 四隅], ...]}` で動かせる |
| `blend` | 下の絵との合成モード。CSSの `mix-blend-mode` と同じ名前（`multiply` `screen` `overlay` `darken` `lighten` `difference` `exclusion` `hard-light` `soft-light` `color-dodge` `color-burn` `plus-lighter`） |
| `scale` `origin` | 拡大。`scale` は数値か `{keyframes, easing}`、`origin` は基準点 `[横, 縦]`（0〜1） |
| `offsetX` `offsetY` | 位置のずらし。数値か `{keyframes, easing}`（揺れ・パン。キーフレームはクリップ先頭からのコマ数） |

層の `x` `y` `width` `height` は、クリップを置く箱の位置と大きさ（既定は全面）。

### scene層

| 指定 | 意味 |
|---|---|
| `id` `scene` | 層の名前と、描くシーンの名前 |
| `region` | その範囲だけを描く（動く帯などを小さく描く） |
| `canvas` と `x` `y` | 好きな大きさの絵を描いて置く。`x` `y` をキーフレームにするとffmpegが絵を動かす |
| `opaque` | 背景色ごと不透明に描き、JPEGで撮る（写真や3Dの多い層が約10倍速い） |
| `page` | ページ内スクリプトで描く（three.jsなど） |
| `blend` | 下の絵との合成モード（video層と同じ名前） |

### adjust層（調整レイヤー）

ここまでに重ねた絵に、まとめて加工をかける。パネルの背景ぼかし、全体の色調整、VHS風の質感など。

| 指定 | 意味 |
|---|---|
| `filter` | CSSの `filter` と同じ書き方（`blur()` と色のフィルタ） |
| `vignette` `grain` | 周辺を暗くする強さ、粒子の強さ（どちらも0〜1）。`seed` で粒子の模様を変えられる |
| `region` `radius` | かける範囲（省くと全体）と、その角丸 |
| `from` `durationInFrames` | かける区間（省くと全体） |

### captions層

シーンを書かずに字幕を重ねる（`browser` で描く）。

| 指定 | 意味 |
|---|---|
| `src` | 字幕ファイル（`.srt` / `.ass` / `.ssa`）。装飾タグは外す |
| `items` | `src` の代わりに `[{from, to, text}]`（コマ数）を直接書く |
| `style` | `fontFamily` `fontSize` `fontWeight` `color` `strokeColor` `strokeWidth` `lineHeight` `letterSpacing` `align` `left` `right` `top` `bottom` `background` `padding` `borderRadius` `shadow` |

話者ごとの色分けなど凝った字幕は、`scene` 層で書く（字幕ファイルは `kasaneru/subtitles` の `readSubtitles` と `toFrames` で読める）。

### audio

| 指定 | 意味 |
|---|---|
| `src` | 音声か、音声の入った動画 |
| `from` `durationInFrames` `trimBefore` | 鳴らす位置、長さ、頭を飛ばす量 |
| `playbackRate` `loop` `reverse` | 速度（音程は保つ）、繰り返し、逆再生 |
| `pitch` | 音程を半音単位で変える（長さは保つ） |
| `group` `duck` | `duck: {by: グループ名, to, attack, release, lead, tail}` で、そのグループのトラックが鳴っている間だけ音量を下げる（BGMを声の下へ） |
| `volume` | 数値か `[[コマ, 値], ...]`（`{keyframes, easing}` でも書ける）。キーフレームの間は直線でつながるので、段差は直前のコマに元の値を置く |
| `fadeIn` `fadeOut` | フェード（コマ数） |

- **音量のキーフレームのコマは、動画全体のコマ番号**（トラックの頭からではない）。`from: 30` のトラックに `[[0, 0], [60, 1]]` と書くと、鳴り始めの30コマ目ですでに0.5になっている。video層の `offsetX` などのキーフレームは「クリップ先頭から」なので、数え方が違う
- キーフレームは何点あってもよい（コマごとに1点でも書き出せる）。直線上に並ぶ点は自動で省く
- **モノラルの素材は、左右へ1倍ずつ入る。** ffmpegの既定の変換（`-ac 2`、左右へ0.707倍ずつ）より3dB大きい。モノラルの声とステレオのBGMを混ぜると、ffmpegの既定の変換で混ぜたときより声だけが3dB大きくなる（実測で全体が -15.6 LUFS → -12.6 LUFS）。ffmpegの既定に合わせるなら、モノラルのトラックの `volume` に0.707を掛ける（キーフレームなら各値に掛ける）

キーフレームは `{"keyframes": [[コマ, 値], ...], "easing": "linear"}`。`easing` は `linear` `inCubic` `outCubic` `inOutCubic`。

## シーンの書き方

- **HTML/React（`scenes.browser`）**: `render(frame, props)` がHTML文字列を返す。`key(frame, props)` は省略でき、その場合は返したHTMLが同じコマを同じ絵として扱う。`.tsx` はそのまま読める（Reactは `renderToStaticMarkup` でHTMLにする）
  - **フック**: 1コマごとに1回描くだけなので、状態と副作用のフックは働かない（`useState` は初期値のまま、`useEffect` は走らない）。`useContext` `useMemo` のように描く間に値を返すだけのものは使える。フレームをContextで配るコードは、`render` の中でProviderに包めば描ける
  - **Reactは1つだけ**: シーンの `react` と `react-dom` は、シーンを置いた場所の `node_modules` から探し、なければkasaneruのものを使う。片方だけがシーン側にあるなど、`react` と `react-dom` が別々の場所から読まれるとReactが2つになり、Contextが壊れる（Providerの値が届かない）。両方とも同じ `node_modules` から読まれるようにする
  - **素材のURL**: ページは `file://` で開き、相対パスの基準（`<base>`）はシーンのファイルがあるフォルダ。`images/a.png` のような相対パスか `file://` のURLで書く。`/images/a.png` のように `/` で始めるとディスクの根を指すので読めない（「読めない素材」として失敗になる）
- **ページ内スクリプト（`scenes.page`）**: `setup(ctx)` を1回、`draw(frame)` をコマごとに呼ぶ。素材は `ctx.assets`（manifestの `assets` のURL）から読む
- **Flutter（`scenes.flutter`）**: 作品側のDartファイルが `final Map<String, KasaneruScene> scenes` を公開する。各シーンは `key` と `build(frame, props)`（Widgetを返す）を持つ。`package:kasaneru_flutter/scenes.dart` と `anim.dart` を読み込める
- アニメーション用の関数は `kasaneru/anim`（`interpolate` `spring` `settle` `random` `noise` `typewriter` `clamp` と各種イージング）。乱数は種から決まるので、書き出すたびに絵が変わらない。シーンをどこに置いても `import {spring} from 'kasaneru/anim'` で読める。Flutterは `package:kasaneru_flutter/anim.dart`

## manifestを作るスクリプトから使える道具

| 読み込み | 内容 |
|---|---|
| `kasaneru/media` | `probeMedia(file, fps)`（長さ・大きさ）、`envelope(file, fps)`（コマごとの音量） |
| `kasaneru/subtitles` | `readSubtitles(file)`、`toFrames(items, fps)` |
| `kasaneru/srt` | `toSrt(items, fps)` |
| `kasaneru/anim` | シーンと同じアニメーション関数 |

## 構成

| 場所 | 内容 |
|---|---|
| `bin/kasaneru.mjs` | CLI |
| `src/ffmpeg.mjs` | manifestからffmpegのフィルタを組み立てる |
| `src/validate.mjs` `src/resolve.mjs` | manifestの検証、省略や便利な書き方（順に並べる・長さの自動計算・ダッキング）の具体化 |
| `src/inspect.mjs` `src/sheet.mjs` `src/media.mjs` `src/srt.mjs` | 動画の点検、コマ一覧、素材を調べる道具、SRT書き出し |
| `src/cssfilter.mjs` | CSSのfilterの書き方を読み、色の変換を3D LUTにする |
| `src/subtitles.mjs` `src/captions.mjs` | 字幕ファイルの読み込み、字幕の層 |
| `src/anim.mjs` | フレームから値を作る関数 |
| `src/backends/browser.mjs` | HTML/Reactのシーンを撮る |
| `src/backends/browser_page.mjs` | ページ内スクリプトのシーンを撮る |
| `src/backends/launch.mjs` `src/backends/deps.mjs` | ブラウザの起動（`KASANERU_BROWSER`）、シーンがimportするkasaneru同梱パッケージの探し場所 |
| `src/backends/flutter.mjs` と `flutter_backend/` | Flutterで描く |
| `test/` | 自動テスト。コマ番号を明るさに埋め込んだ素材で、出力の各コマの中身を判定する |
| `.github/workflows/` | pushごとのテスト（`test.yml`）と、`v*` タグのpushでのnpm公開・GitHub Release作成（`release.yml`） |
| `examples/basic/` | 外部の素材なしで動く例（クロスフェード・フィルタ・回転・角丸・合成モード・字幕） |

## 描画バックエンドの違い

- **browser**: HTML・React・ページ内スクリプト（three.jsのリグ付きGLB、影など）を描ける。フレームをContextで配るReactのコードは、`render` の中でProviderに包めば描ける
- **flutter**: 字幕・テロップなど、ウィジェットで書いた画面を描ける。速度は `browser` と同程度
- **flutterの3D**: `flutter test --enable-impeller --enable-flutter-gpu` でGPUは使えたが、`flutter_scene` のシェーダーが読み込めず描けなかった（"Failed to unpack shader"）。アプリとして起動する方式は試していない

## 落とし穴（実装で踏んだもの）

- **ffmpegの `overlay`**
  - 絵の切り替わりがまばらな入力を重ねると、下の層が1コマ遅れることがある。`fps` で一定間隔のコマ列にしてから重ねる
  - 位置の式で `n` を使うとずれる。`t`（時刻）から計算する
  - `format=yuv420` は位置が2px単位。動く層だけ `yuv444` で重ねる
  - `format=gbrp` と `alpha=premultiplied` の組み合わせは暗く合成される
  - ちょうどの長さに切ったクリップは最終コマが落ちることがある。1コマ長く切り、表示区間は `enable` で決める
- **ffmpegの `scale`**: 既定の丸めでは、色行列の変換（BT.601→BT.709）で輝度が2段暗くなる。`flags=accurate_rnd+full_chroma_int` を必ず付ける
- **`setpts` で開始位置をずらすとき**: 秒へ丸めた値を足すと、切り捨てで1コマ早まることがある。コマ数から式で計算して `round()` する
- **concat入力**: 画像ごとに `option framerate` を書くと表示時刻がコマ単位で正確になる
- **ffmpegの式の入れ子**: キーフレームを先頭から順に `if` の入れ子にすると、100点ほどで式の深さの上限に当たる（"Missing ')' or too many args"）。区間を半分ずつに分けて入れ子にする
- **ブラウザの撮影**
  - 読めなかった画像は `img.decode()` の失敗では数えられない。失敗済みの画像は `complete` のまま残るので、次のコマから待つ対象に入らない。待ったあとの `naturalWidth` で判定する
  - PNGは写真の多い絵だと1枚60ms以上かかり、並列にしても速くならない。CDPの `Page.captureScreenshot` をJPEGか `optimizeForSpeed` 付きPNGで呼ぶ
  - CDPで背景色の指定を送ると画面の大きさの指定が外れることがある。大きさも送り直して実際の値を確かめる
  - HTMLを丸ごと差し替えると画像を毎コマ読み直す。変わった属性と文字だけ書き換える
- **`flutter test`**: フォントの明示読み込み（`.ttc` も読める）、画面サイズとDPRの指定、`debugDisableShadows = false`、`runAsync` の中での `toImage`、CSSの行送りに合わせる `TextLeadingDistribution.even`

## 未実装・未検証

- 回転の基準点（今は箱の中心だけ）、縦横別の拡大、3D変形（四隅を指定する透視合成はできる）
- 色フィルタ・ぼかしのキーフレーム（透明度・拡大・回転・位置・切り出し・四隅はキーフレームにできる）
- クリップ同士のワイプなどの切り替え効果（フェードと位置のキーフレームで作る）
- 透過つきの出力（`.mov` / `.webm` は不透明）
- `captions` 層のFlutter対応、話者ごとのスタイル
- モノラルの素材を0.707倍で入れる切り替え（今は `volume` に手で掛ける）
- `<img>` 以外の素材（CSSの背景画像など）の読み込みを待ってから撮ること、Flutterバックエンドでの読めない素材の検出
- `--frames` での書き出しは、範囲外の動画層も一度合成してから切っている（絵は範囲分しか描かない）
- Windows・Linux（macOSでだけ動かしている）

## ライセンス

MIT（`LICENSE`）。依存は playwright-core（Apache-2.0）、esbuild・react・react-dom・three（MIT）。ffmpeg・Chrome・Flutterは同梱せず、入っているものを呼ぶ。
