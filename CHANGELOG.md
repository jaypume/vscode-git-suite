# Changelog

All notable changes to Git Suite are documented in this file.

## [0.11.0] - 2026-07-29

### Added

- Git Log panel remembers the last-selected repository and reopens it directly on next session; first-time use defaults to the first visible repository instead of loading all.
- Shift-click in the Git Log to range-select commits between the anchor and the clicked row.
- Copy context menu now copies all selected hashes when multiple commits are selected.

### Changed

- Denser commit graph: narrower lane width and shorter row height for a more compact view.
- Commit avatar size adjusted for the tighter rows.

### Fixed

- Fixed a deadlock that froze the Git Log panel on certain repositories (e.g. libra-core) when switching repos — host's committerDate reorder broke the lane-assignment topological invariant.
- Reduced startup flicker: branch/repo changes no longer trigger full commit reloads; icon-theme loads are cached.

## [0.10.0] - 2026-07-28

### Changed

- Simplified the Extension Development Host launch configuration.
- Updated the extension version to 0.10.0.
