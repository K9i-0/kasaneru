# Changelog

All notable changes to `kasaneru` are documented in this file.

## [0.1.0] - 2026-11-26

### Changed

- **Breaking:** mono assets (audio tracks, and clips with `volume`) now go to left and right at 0.707x (−3 dB) each instead of 1x, the same as ffmpeg's default conversion (`-ac 2`). Their audio comes out 3 dB lower than up to 0.0.5, and the same sound now mixes at the same level whether the file is mono or stereo. Multiply the track's `volume` by 1.414 for the old level.
- **Breaking:** `check` (and so `render` / `still`) now rejects values it used to accept: unknown fields in `composition`, a `master`, `master.loudnorm`, `scenes` or `props` that is not an object, unknown or non-numeric fields in `master.loudnorm`, non-numeric fields in `shake`, `chromaKey` and `duck`, and a non-integer `seed` on an `adjust` layer.
- The working folder now carries a marker file. A working folder left by 0.0.5 or earlier (`--keep-work`, or a failed render) has none and is refused until it is removed.

### Fixed

- `render` and `still` no longer delete an existing folder given to `--work` (or an existing `<output name>.work`) that has files in it and was not made by kasaneru. They stop without deleting anything.
- An output placed inside the working folder is refused instead of being deleted together with the folder after the render.
- `check` reports `null` entries (in `layers`, `clips`, `audio`, `fonts` and option objects such as `shake`), a `fonts` that is not an array, and an `audio[].src` that is not a media file with their locations instead of ending in a stack trace.
- `--crf`, `--concurrency`, `--cols`, `--every` and `sheet --frames` are checked before anything runs; a wrong value is named and exits with code 2.
- A missing `ffmpeg`, `ffprobe` or `flutter` is reported in words (exit code 1) instead of a `spawn ENOENT` stack trace, and an ffmpeg failure during a render no longer ends in a stack trace.

## [0.0.5] - 2026-11-25

### Fixed

- A `scene` layer whose pictures change between opaque and transparent (an opaque scene next to the transparent blank used outside a `--frames` range or in a gap) no longer makes ffmpeg rebuild the filter graph mid-render. This fixes a black `still`, a black last frame in `render --frames A-B` (and a black `--frames N-N`), an opaque scene with gaps not being drawn at all, and `render --frames` hanging when the manifest has many audio tracks.

## [0.0.4] - 2026-11-23

### Added

- `audio[].duck.threshold` (dB, default `-35`; or `false` to duck across the entire track span).

### Changed

- Automatic ducking (`duck`) now detects audible spans from the audio waveform of grouped tracks and restores volume during silent stretches instead of ducking across the entire track duration.
- Clarified in README (`README.md` / `README.ja.md`) that `duck.to` is a multiplier applied to `volume`.

## [0.0.3] - 2026-11-21

### Fixed

- `--help` / `-h` and `--version` / `-v` work; an unknown option prints the usage instead of a stack trace.

## [0.0.2] - 2026-11-21

### Changed

- Published by the release workflow through npm trusted publishing, so the package carries provenance. No functional changes from 0.0.1.

## [0.0.1] - 2026-11-21

First public release.

### Added

- CLI: `render`, `still`, `check`, `inspect`, `sheet`, `srt`, `captions`, `probe`, `envelope`.
- Manifest layers: `video`, `scene`, `adjust`, `captions`, plus `audio` and `master`.
- Rendering backends: `browser` (HTML strings, React, in-page scripts such as three.js) and `flutter`.
- Helper modules for scripts that build manifests: `kasaneru/anim`, `kasaneru/media`, `kasaneru/subtitles`, `kasaneru/srt`.

### Security

- The local file server used by `scenes.page` scenes serves only files under the manifest's `assets` folder, and only to requests addressed to its own `127.0.0.1` address.
