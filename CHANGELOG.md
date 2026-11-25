# Changelog

All notable changes to `kasaneru` are documented in this file.

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
