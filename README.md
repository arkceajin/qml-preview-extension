# QML Preview (VS Code Extension)

Preview QML files from CMake Qt targets directly in VS Code.

## Features

- Parse `CMakeLists.txt` recursively and discover `qt_add_executable` targets.
- Choose a target from status bar and run preview quickly.
- Select entry QML from target files:
  - Prefer `Main.qml`
  - Fallback to first QML file in target list
- Resolve `qml` executable from `build/CMakeCache.txt` (`Qt6_DIR`/`Qt5_DIR`/`CMAKE_PREFIX_PATH`).
- Optional hot reload mode via `qmlpreview`.
- Capture process output in **QML Preview** output channel.

## Requirements

- Qt installation with `qml` (and optional `qmlpreview`) executable.
- CMake project with `CMakeLists.txt` and Qt QML modules.

## Configuration

- `qmlPreview.qmlExecutable`:
  - Path to qml executable.
  - Default: `C:/Qt/6.10.2/mingw_64/bin/qml.exe`
- `qmlPreview.qmlEnv`:
  - Environment assignments for qml process.
  - Default: `QT_FORCE_STDERR_LOGGING=1 QT_LOGGING_TO_CONSOLE=1 QT_ASSUME_STDERR_HAS_CONSOLE=1`
- `qmlPreview.hotreload`:
  - `false`: run `qml -I build <entry.qml>`
  - `true`: run `qmlpreview qml -I build <entry.qml>`

## Commands

- `QML Preview: Select Target` (`qmlPreview.selectTarget`)
- `QML Preview: Run Preview` (`qmlPreview.preview`)

Default keybinding:

- `F7` -> `qmlPreview.preview`

## Typical Run Command

Hot reload off:

```sh
qml -I build Main.qml
```

Hot reload on:

```sh
qmlpreview qml -I build Main.qml
```

## Publishing Notes

Before publishing to Marketplace/Open VSX, update the following fields in `package.json`:

- `publisher`
- `repository.url`
- `bugs.url`
- `homepage`

Then package/publish with your preferred flow (for example, `vsce package`, `vsce publish`).
