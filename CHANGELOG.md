# Changelog

All notable changes to `kasaneru` are documented in this file.

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
