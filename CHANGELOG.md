# Change Log

All notable changes to this extension are documented in this file.

## 0.1.0

- Initial release.
- Parse CMake targets and QML files.
- Status bar target selection and preview action.
- QML entry selection logic (prefer `Main.qml`, else first file).
- Resolve Qt path from `build/CMakeCache.txt`.
- Build runtime path injection for local DLL/SO loading.
- Full command/output logging in output channel.
- Configurable process environment via `qmlPreview.qmlEnv`.
- Hot reload support via `qmlPreview.hotreload`.
- Default keybinding `F7` for preview.
