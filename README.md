# kasaneru

[日本語](README.ja.md)

A tool that renders video from a manifest (JSON). kasaneru (重ねる) means "to layer" in Japanese: you build a video by stacking layers.

- Cutting, arranging, and compositing video and audio is done by `ffmpeg` (an external command)
- Text, shapes, and 3D are turned into images by a "rendering backend". Frames that produce the same picture are drawn only once
- There are two rendering backends. Neither opens a window
  - `browser`: drives your local Chrome through Playwright and captures it. Draws HTML strings, React, and in-page scripts (three.js and the like)
  - `flutter`: extracts widgets with `RepaintBoundary.toImage` inside `flutter test`

It has only been verified on macOS. It has not been run on Windows or Linux.

## Usage

```bash
git clone https://github.com/K9i-0/kasaneru.git
cd kasaneru && npm install
node examples/basic/make-assets.mjs          # generate the example's assets with ffmpeg (no external assets needed)
node bin/kasaneru.mjs check   examples/basic/manifest.json
node bin/kasaneru.mjs render  examples/basic/manifest.json -o out/basic.mp4
node bin/kasaneru.mjs still   examples/basic/manifest.json --frame 100 -o out/basic_100.png
node bin/kasaneru.mjs inspect out/basic.mp4
```

| Command | What it does |
|---|---|
| `check <manifest>` | Lists every error in the manifest, with its location, without rendering (JSON; exit code 1 if there are errors) |
| `render <manifest> -o <mp4>` | Renders. Runs the same validation as `check` first and does not render if there are errors |
| `still <manifest> --frame N -o <png>` | Renders a single frame. Fast, because it draws only the pictures that frame needs |
| `inspect <video>` | Reports duration, frame count, and volume, and whether the first frame is dark or the audio is clipping |
| `inspect <video> --deep` | In addition to the above, looks for single frames with a broken picture (blank white, garbled) (`suspectFrames`). The first and last frames can only be compared with one neighbor, so when they differ greatly from it they are listed as a weak warning (`edgeFrames`; this cannot be told apart from a cut, so check by eye) |
| `sheet <video> -o <png>` | Makes a contact sheet of frames for review. `--frames 0,120,240`, `--every N`, `--manifest <manifest>` (automatically picks frames just before and after clip and caption changes) |
| `srt <manifest> -o <srt>` | Writes the captions as SRT (from `captions` layers; `--key props.captions` can point at another location) |
| `captions <subtitle file> --fps N` | Converts SRT/ASS to JSON `[{from, to, text}]` (in frames) |
| `probe <asset> [--fps N]` | Reports an asset's length (in frames), dimensions, and whether it has audio |
| `envelope <audio> --fps N` | Outputs the per-frame volume as an array (for lip sync and the like) |

Main options for `render`:

- `--backend browser|flutter|none` (default `browser`; `none` renders video layers only)
- The output format is determined by the extension: `.mp4` (H.264), `.mov` (ProRes 422 HQ), `.webm` (VP9), `.gif`
- `--frames A-B` renders only part of the frames (for review)
- `--props <file or JSON>` and `--set path=value` override the manifest's `props` (to make variants, such as different wording, from the same manifest)
- `--concurrency N` is the number of pages drawn at once (`browser`, default 4)
- `--encoder h264_videotoolbox` uses the Mac hardware encoder
- `--audio-bitrate 256k` changes the audio bitrate (default is 192k for `.mp4` and 160k for `.webm`; it has no effect on `.mov`, which is uncompressed)
- `--allow-missing-assets` renders even if a scene's assets cannot be loaded (see "Missing assets" below)
- `--keep-work` keeps the working folder (the drawn pictures and the ffmpeg filter) instead of deleting it

The result, a timing breakdown plus warnings, is written to standard output as JSON.

### Missing assets

When an image in a scene drawn by `browser` cannot be loaded (the file does not exist, is corrupt, or does not finish loading within 30 seconds), the render fails (exit code 1) after all pictures have been drawn and before the video is made. The URL that could not be loaded, the layer and frame where it was first noticed, and the number of pictures affected are written to standard error.

- What is checked: `<img>` (a `naturalWidth` of 0 after loading) and load failures reported by the page (CSS background images, SVG `<image>`, fonts, and so on). For `scenes.page` scenes, files requested from `ctx.assets` that did not exist
- With `--allow-missing-assets`, the render does not fail; the same information goes into `warnings` in the result JSON and the video is rendered
- The wait time can be changed with the environment variable `KASANERU_IMAGE_TIMEOUT_MS`. Once an image has timed out, later pictures count it as a failure without waiting again
- Loads cancelled partway (such as a background image no longer needed in the next frame) are not counted as failures
- Anything other than `<img>` is captured without waiting for it to load. Local files load immediately, so this has caused no real problems, but a background image may miss the capture, or a failure report may arrive too late. Use `<img>` for images that must be waited for
- In-page errors in `scenes.page` scenes (`pageerror`) do not fail the render; they go into `warnings`

Requirements: Node 22, ffmpeg, Google Chrome (`browser`), Flutter (`flutter`). Run the tests with `npm test`.

The browser can be changed with the environment variable `KASANERU_BROWSER` (the path to an executable, or a name such as `chrome-beta`, `msedge`, or `chromium`).

## manifest

All times are written as frame counts (integers) at the composition's fps. Paths are relative to the manifest's location.

| Field | Description |
|---|---|
| `composition` | `width` `height` `fps` `durationInFrames`. If `durationInFrames` is omitted, it is set to the end of the latest-ending clip or audio track |
| `background` | Background color (`#RRGGBB`) |
| `layers` | Layers, stacked from the bottom up. `video` / `scene` / `captions` / `adjust` |
| `audio` | Array of audio tracks |
| `master` | Audio mastering. `limiter` (ceiling, 0–1) and `loudnorm` (`i` `tp` `lra`) |
| `scenes` | Where the scenes are. `browser` (HTML/React), `page` (in-page script), `flutter` (Dart file) |
| `assets` | Folder of assets loaded by `page` scenes |
| `fonts` | Font files to load (`family` `file`, plus `weight` `style` if needed). For fonts not installed on the system |
| `props` | Values passed to scenes |

### video layer

List clips in `clips`. If there is only one clip, `src` and the rest can be written directly on the layer. Besides video, still images (png, jpg, webp) and solid colors can be placed. With assets that have transparency (such as transparent PNGs), the layers below show through the transparent areas (for example, a title overlaid on video).

Setting `"sequence": true` on a layer lines the clips up one after another (`from` is set automatically and lengths are read from the assets). `overlap` makes neighboring clips overlap (combined with fades, this gives a crossfade).

| Clip option | Meaning |
|---|---|
| `src` | A video or still image |
| `color` | Written instead of `src`, gives a picture filled with that color (blackouts, bars, color overlays) |
| `from` `durationInFrames` | Where it appears and for how long |
| `trimBefore` | How many frames to skip at the start of the asset |
| `playbackRate` | Speed (2 is double speed, 0.5 is half) |
| `loop` | `true` repeats the whole asset. A number repeats that length (in frames) |
| `freeze` | Holds on that frame of the asset |
| `reverse` | Plays in reverse |
| `crop` | Cuts out part of the asset `{x, y, width, height}` (in asset px). `x` and `y` can be keyframed (such as panning when converting to vertical video) |
| `shake` | Shake `{amplitude, speed, from, durationInFrames, seed, decay}`. No random numbers are used, so every render produces the same picture |
| `fadeIn` `fadeOut` | Opacity fades (in frames). Used on overlapping clips, they give a crossfade |
| `volume` | When set, the video's audio also plays at the same position (a number or keyframes). When not set, the clip is silent. Keyframe frames and mono handling are the same as for `audio` (frame numbers of the whole video, not counted from the start of the clip) |

The following options apply to every clip when written on the layer, or to a single clip when written on that clip.

| Option | Meaning |
|---|---|
| `fit` | `cover` (crops the overflow, default) / `fill` (stretches) / `contain` (fits the whole picture; the margins are transparent) |
| `align` | Anchor position when `cover` crops, `[horizontal, vertical]` (0–1, default is center) |
| `flip` | Flip. `h` (horizontal) / `v` (vertical) / `hv` |
| `filter` | Same syntax as CSS `filter`. Applies `brightness()` `contrast()` `saturate()` `grayscale()` `sepia()` `invert()` `hue-rotate()` `blur()` `opacity()` in order |
| `opacity` | Opacity. A number or `{keyframes, easing}` |
| `blur` | Blur (same unit as CSS blur) |
| `rotate` | Rotation (degrees, clockwise). A number or `{keyframes, easing}`. Rotates around the center of the box; anything that sticks out is cropped |
| `radius` `mask` | Rounded corners (px). `mask` is `"ellipse"` or a black-and-white image (white areas are kept) |
| `chromaKey` | Makes the given color transparent `{color, similarity, blend}` (green screen and the like) |
| `corners` | Fits the picture into a quad by giving the destinations of its four corners (top-left, top-right, bottom-left, bottom-right) in composition coordinates (screen replacement and the like). Can be animated with `{keyframes: [[frame, corners], ...]}` |
| `blend` | Blend mode with the picture below. Same names as CSS `mix-blend-mode` (`multiply` `screen` `overlay` `darken` `lighten` `difference` `exclusion` `hard-light` `soft-light` `color-dodge` `color-burn` `plus-lighter`) |
| `scale` `origin` | Scaling. `scale` is a number or `{keyframes, easing}`; `origin` is the anchor point `[horizontal, vertical]` (0–1) |
| `offsetX` `offsetY` | Position offset. A number or `{keyframes, easing}` (shakes, pans; keyframes are counted in frames from the start of the clip) |

The layer's `x` `y` `width` `height` are the position and size of the box the clips are placed in (default is the full frame).

### scene layer

| Option | Meaning |
|---|---|
| `id` `scene` | The layer's name, and the name of the scene to draw |
| `region` | Draws only that area (to draw a moving bar or similar at a small size) |
| `canvas` and `x` `y` | Draws a picture of any size and places it. If `x` `y` are keyframed, ffmpeg moves the picture |
| `opaque` | Draws opaque, background color included, and captures as JPEG (about 10x faster for layers heavy in photos or 3D) |
| `page` | Draws with an in-page script (three.js and the like) |
| `blend` | Blend mode with the picture below (same names as the video layer) |

### adjust layer (adjustment layer)

Applies processing to everything stacked so far, all at once. Background blur behind a panel, overall color adjustment, a VHS-like texture, and so on.

| Option | Meaning |
|---|---|
| `filter` | Same syntax as CSS `filter` (`blur()` and the color filters) |
| `vignette` `grain` | Strength of edge darkening and strength of grain (both 0–1). `seed` changes the grain pattern |
| `region` `radius` | The area to affect (the whole frame if omitted) and its corner radius |
| `from` `durationInFrames` | The span to affect (the whole duration if omitted) |

### captions layer

Overlays captions without writing a scene (drawn by `browser`).

| Option | Meaning |
|---|---|
| `src` | Subtitle file (`.srt` / `.ass` / `.ssa`). Styling tags are stripped |
| `items` | Instead of `src`, write `[{from, to, text}]` (in frames) directly |
| `style` | `fontFamily` `fontSize` `fontWeight` `color` `strokeColor` `strokeWidth` `lineHeight` `letterSpacing` `align` `left` `right` `top` `bottom` `background` `padding` `borderRadius` `shadow` |

For more elaborate captions, such as per-speaker colors, write them in a `scene` layer (subtitle files can be read with `readSubtitles` and `toFrames` from `kasaneru/subtitles`).

### audio

| Option | Meaning |
|---|---|
| `src` | Audio, or a video that contains audio |
| `from` `durationInFrames` `trimBefore` | Where it plays, for how long, and how much to skip at the start |
| `playbackRate` `loop` `reverse` | Speed (pitch is preserved), repeat, reverse playback |
| `pitch` | Changes pitch in semitones (length is preserved) |
| `group` `duck` | `duck: {by: group name, to, attack, release, lead, tail}` lowers the volume only while tracks in that group are playing (BGM under voice) |
| `volume` | A number or `[[frame, value], ...]` (`{keyframes, easing}` also works). Keyframes are joined by straight lines, so for a step, put the old value on the frame just before |
| `fadeIn` `fadeOut` | Fades (in frames) |

- **Volume keyframe frames are frame numbers of the whole video** (not counted from the start of the track). With `[[0, 0], [60, 1]]` on a track with `from: 30`, the volume is already 0.5 at frame 30, when it starts playing. Keyframes such as `offsetX` on video layers are counted "from the start of the clip", so the two count differently
- Any number of keyframes is fine (even one per frame renders). Points that lie on a straight line are dropped automatically
- **Mono assets go to left and right at 1x each.** This is 3 dB louder than ffmpeg's default conversion (`-ac 2`, 0.707x to each side). When you mix mono voice with stereo BGM, only the voice comes out 3 dB louder than it would with ffmpeg's default conversion (measured: overall -15.6 LUFS → -12.6 LUFS). To match the ffmpeg default, multiply the mono track's `volume` by 0.707 (for keyframes, multiply each value)

Keyframes are `{"keyframes": [[frame, value], ...], "easing": "linear"}`. `easing` is one of `linear` `inCubic` `outCubic` `inOutCubic`.

## Writing scenes

- **HTML/React (`scenes.browser`)**: `render(frame, props)` returns an HTML string. `key(frame, props)` is optional; without it, frames that return the same HTML are treated as the same picture. `.tsx` files load as they are (React is turned into HTML with `renderToStaticMarkup`)
  - **Hooks**: each frame is drawn just once, so state and effect hooks do not work (`useState` stays at its initial value, `useEffect` does not run). Hooks that only return a value during rendering, such as `useContext` and `useMemo`, can be used. Code that distributes the frame through Context works if you wrap it in a Provider inside `render`
  - **Only one React**: a scene's `react` and `react-dom` are looked up in the `node_modules` next to where the scene lives, falling back to kasaneru's own. If `react` and `react-dom` are loaded from different places (for example, only one of them exists on the scene side), there are two Reacts and Context breaks (the Provider's value does not arrive). Make sure both are loaded from the same `node_modules`
  - **Asset URLs**: the page is opened as `file://`, and the base for relative paths (`<base>`) is the folder containing the scene file. Write relative paths such as `images/a.png`, or `file://` URLs. A path that starts with `/`, such as `/images/a.png`, points at the root of the disk and cannot be loaded (it fails as a "missing asset")
- **In-page script (`scenes.page`)**: `setup(ctx)` is called once and `draw(frame)` for every frame. Assets are loaded from `ctx.assets` (the URL of the manifest's `assets`)
- **Flutter (`scenes.flutter`)**: a Dart file on the project side exposes `final Map<String, KasaneruScene> scenes`. Each scene has a `key` and a `build(frame, props)` (returning a Widget). `package:kasaneru_flutter/scenes.dart` and `anim.dart` can be imported
- Animation functions are in `kasaneru/anim` (`interpolate` `spring` `settle` `random` `noise` `typewriter` `clamp` and various easings). Random numbers are determined by a seed, so the picture does not change from render to render. Wherever a scene is placed, `import {spring} from 'kasaneru/anim'` works. For Flutter, use `package:kasaneru_flutter/anim.dart`

## Tools for scripts that build manifests

| Import | Contents |
|---|---|
| `kasaneru/media` | `probeMedia(file, fps)` (length, dimensions), `envelope(file, fps)` (per-frame volume) |
| `kasaneru/subtitles` | `readSubtitles(file)`, `toFrames(items, fps)` |
| `kasaneru/srt` | `toSrt(items, fps)` |
| `kasaneru/anim` | The same animation functions as in scenes |

## Layout

| Location | Contents |
|---|---|
| `bin/kasaneru.mjs` | CLI |
| `src/ffmpeg.mjs` | Builds the ffmpeg filter from the manifest |
| `src/validate.mjs` `src/resolve.mjs` | Manifest validation; resolving omissions and shorthands (sequencing, automatic length calculation, ducking) into concrete values |
| `src/inspect.mjs` `src/sheet.mjs` `src/media.mjs` `src/srt.mjs` | Video inspection, contact sheets, asset probing tools, SRT output |
| `src/cssfilter.mjs` | Parses CSS filter syntax and turns the color transforms into a 3D LUT |
| `src/subtitles.mjs` `src/captions.mjs` | Subtitle file loading, the captions layer |
| `src/anim.mjs` | Functions that produce values from the frame |
| `src/backends/browser.mjs` | Captures HTML/React scenes |
| `src/backends/browser_page.mjs` | Captures in-page script scenes |
| `src/backends/flutter.mjs` and `flutter_backend/` | Draws with Flutter |
| `test/` | Automated tests. Uses assets with the frame number embedded in their brightness to check the content of each output frame |
| `examples/basic/` | An example that runs without external assets (crossfade, filters, rotation, rounded corners, blend modes, captions) |

## Differences between rendering backends

- **browser**: draws HTML, React, and in-page scripts (rigged GLBs in three.js, shadows, and so on). React code that distributes the frame through Context can be drawn by wrapping it in a Provider inside `render`
- **flutter**: draws screens written with widgets, such as captions and on-screen titles. Speed is about the same as `browser`
- **3D in flutter**: the GPU was usable with `flutter test --enable-impeller --enable-flutter-gpu`, but the `flutter_scene` shaders failed to load and nothing could be drawn ("Failed to unpack shader"). Launching as an app has not been tried

## Pitfalls (ones hit during implementation)

- **ffmpeg `overlay`**
  - When overlaying an input whose pictures change only sparsely, the layer below can lag by one frame. Convert it to a constant-interval frame sequence with `fps` before overlaying
  - Using `n` in the position expression causes drift. Compute from `t` (time)
  - With `format=yuv420`, positions move in 2 px steps. Overlay only the moving layers in `yuv444`
  - The combination of `format=gbrp` and `alpha=premultiplied` composites too dark
  - A clip cut to exactly its length can lose its last frame. Cut it one frame longer and set the visible span with `enable`
- **ffmpeg `scale`**: with the default rounding, the color matrix conversion (BT.601→BT.709) darkens luma by 2 levels. Always add `flags=accurate_rnd+full_chroma_int`
- **Shifting the start position with `setpts`**: adding a value rounded to seconds can come out one frame early because of truncation. Compute it in an expression from the frame count and `round()` it
- **concat input**: writing `option framerate` for each image makes display times frame-accurate
- **Nesting in ffmpeg expressions**: nesting `if` for keyframes in order from the first one hits the expression depth limit at around 100 points ("Missing ')' or too many args"). Split the span in halves and nest those instead
- **Browser capture**
  - Images that failed to load cannot be counted by `img.decode()` failures. A failed image stays `complete`, so from the next frame on it is no longer among the things waited for. Judge by `naturalWidth` after waiting
  - PNG takes 60 ms or more per image for photo-heavy pictures, and parallelism does not make it faster. Call CDP's `Page.captureScreenshot` with JPEG, or with PNG plus `optimizeForSpeed`
  - Sending a background color override over CDP can drop the viewport size override. Send the size again as well and check the actual value
  - Replacing the whole HTML reloads the images on every frame. Rewrite only the attributes and text that changed
- **`flutter test`**: explicit font loading (`.ttc` works too), setting the screen size and DPR, `debugDisableShadows = false`, calling `toImage` inside `runAsync`, and `TextLeadingDistribution.even` to match CSS line spacing

## Not implemented / not verified

- A rotation origin (currently only the center of the box), separate horizontal and vertical scaling, 3D transforms (perspective compositing by specifying four corners is possible)
- Keyframes for color filters and blur (opacity, scale, rotation, position, crop, and corners can be keyframed)
- Transition effects between clips, such as wipes (build them from fades and position keyframes)
- Output with transparency (`.mov` / `.webm` are opaque)
- Flutter support for the `captions` layer, per-speaker styles
- A switch to bring mono assets in at 0.707x (for now, multiply `volume` by hand)
- Waiting for assets other than `<img>` (such as CSS background images) to load before capturing; detecting missing assets in the Flutter backend
- `--frames` still composites video layers outside the range once and trims afterwards (pictures are drawn only for the range)
- Windows and Linux (it has only been run on macOS)

## License

MIT (`LICENSE`). Dependencies are playwright-core (Apache-2.0) and esbuild, react, react-dom, and three (MIT). ffmpeg, Chrome, and Flutter are not bundled; kasaneru calls whatever is installed.
