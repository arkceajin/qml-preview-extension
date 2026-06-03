import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

interface QtTarget {
    name: string;
    qmlFiles: string[];
}

interface CMakeFile {
    file: string;
    dir: string;
}

function normalizeQmlFileToken(token: string): string {
    return token.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function resolveQmlFilePath(token: string, cmakeDir: string): string {
    const normalized = normalizeQmlFileToken(token)
        .replace(/\$\{CMAKE_CURRENT_SOURCE_DIR\}/g, cmakeDir)
        .replace(/\$\{CMAKE_CURRENT_LIST_DIR\}/g, cmakeDir);

    if (path.isAbsolute(normalized)) {
        return path.normalize(normalized);
    }

    return path.normalize(path.join(cmakeDir, normalized));
}

// Recursively gather CMakeLists.txt files following add_subdirectory
function gatherCMakeFiles(workspaceRoot: string): CMakeFile[] {
    const result: CMakeFile[] = [];
    const visited = new Set<string>();

    function visit(dir: string) {
        if (visited.has(dir)) { return; }
        visited.add(dir);

        const cmakePath = path.join(dir, 'CMakeLists.txt');
        if (!fs.existsSync(cmakePath)) { return; }

        result.push({ file: cmakePath, dir });

        const content = fs.readFileSync(cmakePath, 'utf-8');
        const subdirRegex = /add_subdirectory\s*\(\s*(\S+)/g;
        let m: RegExpExecArray | null;
        while ((m = subdirRegex.exec(content)) !== null) {
            visit(path.join(dir, m[1]));
        }
    }

    visit(workspaceRoot);
    return result;
}

// Parse all CMakeLists.txt files and return qt_add_executable targets with their QML files
function parseQtTargets(workspaceRoot: string): QtTarget[] {
    const cmakeFiles = gatherCMakeFiles(workspaceRoot);
    const executableTargets = new Set<string>();
    const qmlModules = new Map<string, string[]>();

    for (const { file, dir } of cmakeFiles) {
        const content = fs.readFileSync(file, 'utf-8');

        // Find qt_add_executable targets
        const execRegex = /qt_add_executable\s*\(\s*(\w+)/g;
        let m: RegExpExecArray | null;
        while ((m = execRegex.exec(content)) !== null) {
            executableTargets.add(m[1]);
        }

        // Find qt_add_qml_module blocks and extract QML_FILES
        // Match the full parenthesized block (handles multiline)
        const moduleRegex = /qt_add_qml_module\s*\(([^)]+)\)/gs;
        while ((m = moduleRegex.exec(content)) !== null) {
            const block = m[1];
            const nameMatch = block.match(/^\s*(\w+)/);
            if (!nameMatch) { continue; }
            const targetName = nameMatch[1];

            // Extract everything after QML_FILES until the next ALL_CAPS keyword or end
            const qmlFilesMatch = block.match(/QML_FILES\s+([\s\S]*?)(?=\s+[A-Z][A-Z_]{1,}\s|\s*$)/);
            if (!qmlFilesMatch) { continue; }

            const files = qmlFilesMatch[1].trim().split(/\s+/).filter(f => f.length > 0);
            const absPaths = files.map(f => resolveQmlFilePath(f, dir));

            const existing = qmlModules.get(targetName) ?? [];
            qmlModules.set(targetName, [...existing, ...absPaths]);
        }
    }

    return Array.from(executableTargets).map(name => ({
        name,
        qmlFiles: qmlModules.get(name) ?? []
    }));
}

let selectedTarget: QtTarget | undefined;
let allTargets: QtTarget[] = [];
let targetStatusBar: vscode.StatusBarItem;
let previewStatusBar: vscode.StatusBarItem;
let qmlProcess: ChildProcess | undefined;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    // Output channel for QML process output
    outputChannel = vscode.window.createOutputChannel('QML Preview');
    context.subscriptions.push(outputChannel);

    // Status bar: target selector (left side)
    targetStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    targetStatusBar.command = 'qmlPreview.selectTarget';
    targetStatusBar.tooltip = 'Click to select Qt executable target';
    context.subscriptions.push(targetStatusBar);

    // Status bar: preview button
    previewStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    previewStatusBar.command = 'qmlPreview.preview';
    previewStatusBar.text = '$(play) Preview';
    previewStatusBar.tooltip = 'Run QML Preview';
    context.subscriptions.push(previewStatusBar);

    // Command: select target
    context.subscriptions.push(
        vscode.commands.registerCommand('qmlPreview.selectTarget', async () => {
            refreshTargets();

            if (allTargets.length === 0) {
                vscode.window.showWarningMessage('No qt_add_executable targets found in CMakeLists.txt');
                return;
            }

            const items = allTargets.map(t => ({
                label: t.name,
                description: t.qmlFiles.length > 0
                    ? t.qmlFiles.map(f => path.basename(f)).join(', ')
                    : '(no QML files)'
            }));

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select Qt executable target for QML Preview'
            });

            if (picked) {
                selectedTarget = allTargets.find(t => t.name === picked.label);
                updateStatusBar();
            }
        })
    );

    // Command: run preview
    context.subscriptions.push(
        vscode.commands.registerCommand('qmlPreview.preview', async () => {
            await runPreview();
        })
    );

    // Initial parse
    refreshTargets();
    updateStatusBar();

    // Watch CMakeLists.txt changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/CMakeLists.txt');
    watcher.onDidChange(() => { refreshTargets(); updateStatusBar(); });
    watcher.onDidCreate(() => { refreshTargets(); updateStatusBar(); });
    context.subscriptions.push(watcher);
}

function refreshTargets() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }

    allTargets = parseQtTargets(folders[0].uri.fsPath);

    if (!selectedTarget && allTargets.length > 0) {
        selectedTarget = allTargets[0];
    } else if (selectedTarget) {
        selectedTarget = allTargets.find(t => t.name === selectedTarget!.name) ?? allTargets[0];
    }
}

function updateStatusBar() {
    if (allTargets.length === 0) {
        targetStatusBar.text = '$(list-selection) No Qt targets';
        previewStatusBar.hide();
    } else {
        targetStatusBar.text = `$(list-selection) ${selectedTarget?.name ?? 'Select target'}`;
        previewStatusBar.show();
    }
    targetStatusBar.show();
}

async function extractQtPathFromCMakeCache(): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return null; }

    const workspaceRoot = folders[0].uri.fsPath;
    const cacheFile = path.join(workspaceRoot, 'build', 'CMakeCache.txt');

    if (!fs.existsSync(cacheFile)) {
        outputChannel.appendLine(`[QML Preview] CMakeCache.txt not found at ${cacheFile}`);
        return null;
    }

    try {
        const content = fs.readFileSync(cacheFile, 'utf-8');
        const lines = content.split('\n');

        // Try to find Qt6_DIR first
        for (const line of lines) {
            if (line.startsWith('Qt6_DIR:PATH=') || line.startsWith('Qt6_DIR:STRING=')) {
                let qtPath = line.split('=')[1].trim();
                if (qtPath) {
                    outputChannel.appendLine(`[QML Preview] Found Qt6_DIR: ${qtPath}`);
                    // Qt6_DIR points to lib/cmake/Qt6, we need to go up to the Qt root
                    qtPath = qtPath.replace(/\\/g, '/');
                    if (qtPath.endsWith('/lib/cmake/Qt6')) {
                        qtPath = qtPath.substring(0, qtPath.length - '/lib/cmake/Qt6'.length);
                        outputChannel.appendLine(`[QML Preview] Extracted Qt root: ${qtPath}`);
                    }
                    return qtPath;
                }
            }
        }

        // Try Qt5_DIR
        for (const line of lines) {
            if (line.startsWith('Qt5_DIR:PATH=') || line.startsWith('Qt5_DIR:STRING=')) {
                let qtPath = line.split('=')[1].trim();
                if (qtPath) {
                    outputChannel.appendLine(`[QML Preview] Found Qt5_DIR: ${qtPath}`);
                    // Qt5_DIR also points to lib/cmake/Qt5
                    qtPath = qtPath.replace(/\\/g, '/');
                    if (qtPath.endsWith('/lib/cmake/Qt5')) {
                        qtPath = qtPath.substring(0, qtPath.length - '/lib/cmake/Qt5'.length);
                        outputChannel.appendLine(`[QML Preview] Extracted Qt root: ${qtPath}`);
                    }
                    return qtPath;
                }
            }
        }

        // Try CMAKE_PREFIX_PATH
        for (const line of lines) {
            if (line.startsWith('CMAKE_PREFIX_PATH:PATH=')) {
                const paths = line.split('=')[1].trim().split(';');
                for (const p of paths) {
                    const trimmed = p.trim();
                    if (trimmed.toLowerCase().includes('qt')) {
                        outputChannel.appendLine(`[QML Preview] Found Qt path from CMAKE_PREFIX_PATH: ${trimmed}`);
                        return trimmed;
                    }
                }
            }
        }
    } catch (err) {
        outputChannel.appendLine(`[QML Preview] Error reading CMakeCache.txt: ${err}`);
    }

    return null;
}

async function extractQtPathFromExtensions(): Promise<string | null> {
    try {
        // Try CMake Tools Extension
        const cmakeExt = vscode.extensions.getExtension('ms-vscode.cmake-tools');
        if (cmakeExt && cmakeExt.isActive) {
            outputChannel.appendLine(`[QML Preview] CMake Tools extension found and active`);
            // Try to access CMake Tools API if available
            if (cmakeExt.exports && typeof cmakeExt.exports.getActiveKitName === 'function') {
                try {
                    const kitName = await cmakeExt.exports.getActiveKitName();
                    outputChannel.appendLine(`[QML Preview] Active CMake kit: ${kitName}`);
                } catch (e) {
                    // API might not be available
                }
            }
        }
    } catch (err) {
        outputChannel.appendLine(`[QML Preview] Error accessing CMake Extension: ${err}`);
    }

    return null;
}

function getQmlExecutable(): string {
    const config = vscode.workspace.getConfiguration('qmlPreview');
    return config.get<string>('qmlExecutable') ?? 'C:/Qt/6.10.2/mingw_64/bin/qml.exe';
}

function getHotReloadEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('qmlPreview');
    return config.get<boolean>('hotreload') ?? false;
}

function parseEnvAssignments(input: string): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    const pattern = /([^\s=]+)=((?:"[^"]*"|'[^']*'|[^\s])+)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(input)) !== null) {
        const key = match[1];
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }

    return result;
}

function getConfiguredQmlEnv(): NodeJS.ProcessEnv {
    const config = vscode.workspace.getConfiguration('qmlPreview');
    const configured = config.get<string>('qmlEnv')
        ?? 'QT_FORCE_STDERR_LOGGING=1 QT_LOGGING_TO_CONSOLE=1 QT_ASSUME_STDERR_HAS_CONSOLE=1';
    return parseEnvAssignments(configured);
}

function selectEntryQml(target: QtTarget): string | null {
    if (target.qmlFiles.length === 0) {
        return null;
    }

    const mainQml = target.qmlFiles.find(
        f => path.basename(normalizeQmlFileToken(f)).toLowerCase() === 'main.qml'
    );
    return mainQml ?? target.qmlFiles[0];
}

function prependEnvList(
    env: NodeJS.ProcessEnv,
    key: string,
    values: string[],
    separator: string
) {
    if (values.length === 0) {
        return;
    }

    const existing = env[key] ?? '';
    env[key] = existing ? `${values.join(separator)}${separator}${existing}` : values.join(separator);
}

function collectExistingDirs(dirs: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const dir of dirs) {
        const normalized = path.normalize(dir);
        if (seen.has(normalized)) {
            continue;
        }
        if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
            seen.add(normalized);
            result.push(normalized);
        }
    }

    return result;
}

async function runPreview() {
    if (!selectedTarget) {
        vscode.window.showWarningMessage('No QML target selected. Click the target selector first.');
        return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('No workspace folder found.');
        return;
    }

    // Kill previous process if still running
    if (qmlProcess && !qmlProcess.killed) {
        qmlProcess.kill();
        qmlProcess = undefined;
    }

    // Clear previous output
    outputChannel.clear();
    outputChannel.show();
    outputChannel.appendLine(`[QML Preview] Searching for Qt path...`);

    // Try to get Qt path from CMakeCache.txt
    const qtPath = await extractQtPathFromCMakeCache();
    
    let qmlExe = getQmlExecutable();
    if (qtPath) {
        qmlExe = path.join(qtPath, 'bin', process.platform === 'win32' ? 'qml.exe' : 'qml');
    }

    const workspaceRoot = folders[0].uri.fsPath;
    outputChannel.appendLine(`[QML Preview] Target QML files: ${selectedTarget.qmlFiles.join(', ')}`);
    const entryQmlAbs = selectEntryQml(selectedTarget);
    if (!entryQmlAbs) {
        vscode.window.showWarningMessage(
            `Target "${selectedTarget.name}" has no QML files defined in qt_add_qml_module.`
        );
        return;
    }

    let qmlEntry = path.relative(workspaceRoot, entryQmlAbs);
    if (!qmlEntry || qmlEntry.startsWith('..')) {
        qmlEntry = path.basename(entryQmlAbs);
        outputChannel.appendLine(
            `[QML Preview] Entry QML is outside workspace root, fallback to file name: ${qmlEntry}`
        );
    }

    qmlEntry = qmlEntry.replace(/\\/g, '/');
    const buildDirName = 'build';
    const qmlArgs = ['-I', buildDirName, qmlEntry];
    const hotreload = getHotReloadEnabled();
    let launchExe = qmlExe;
    let launchArgs = [...qmlArgs];

    if (hotreload) {
        const previewExe = path.join(path.dirname(qmlExe), process.platform === 'win32' ? 'qmlpreview.exe' : 'qmlpreview');
        launchExe = previewExe;
        launchArgs = [qmlExe, ...qmlArgs];
    }

    const quoteArg = (value: string) => /[\s"]/g.test(value)
        ? `"${value.replace(/"/g, '\\"')}"`
        : value;
    const fullCommand = [launchExe, ...launchArgs].map(quoteArg).join(' ');

    outputChannel.appendLine(`[QML Preview] Starting: ${qmlExe}`);
    outputChannel.appendLine(`[QML Preview] Args: ${qmlArgs.join(' ')}`);
    outputChannel.appendLine(`[QML Preview] Selected entry: ${qmlEntry}`);
    outputChannel.appendLine(`[QML Preview] Hot reload: ${hotreload ? 'on' : 'off'}`);
    outputChannel.appendLine(`[QML Preview] Full command: ${fullCommand}`);
    outputChannel.appendLine('---');

    outputChannel.appendLine(`[QML Preview] Working directory: ${workspaceRoot}`);
    outputChannel.appendLine(`[QML Preview] Exec: (cd ${workspaceRoot}) && ${fullCommand}`);

    const configuredQmlEnv = getConfiguredQmlEnv();
    const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...configuredQmlEnv
    };

    const buildDir = path.join(workspaceRoot, 'build');
    const runtimeDirs = collectExistingDirs([
        buildDir,
        path.join(buildDir, 'bin'),
        path.join(buildDir, 'lib'),
        path.join(buildDir, 'qml'),
        path.join(buildDir, 'plugins')
    ]);
    const listSep = process.platform === 'win32' ? ';' : ':';

    if (process.platform === 'win32') {
        prependEnvList(childEnv, 'PATH', runtimeDirs, listSep);
    } else if (process.platform === 'darwin') {
        prependEnvList(childEnv, 'DYLD_LIBRARY_PATH', runtimeDirs, listSep);
    } else {
        prependEnvList(childEnv, 'LD_LIBRARY_PATH', runtimeDirs, listSep);
    }

    const configuredEnvText = Object.entries(configuredQmlEnv)
        .map(([k, v]) => `${k}=${v ?? ''}`)
        .join(' ');
    outputChannel.appendLine(`[QML Preview] Env: ${configuredEnvText}`);
    outputChannel.appendLine(`[QML Preview] Runtime dirs: ${runtimeDirs.join(', ')}`);

    qmlProcess = spawn(launchExe, launchArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: workspaceRoot,
        shell: false,
        env: childEnv
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const flushBufferedLines = (buffer: string, prefix: string): string => {
        const lines = buffer.split(/\r?\n/);
        const remainder = lines.pop() ?? '';
        for (const line of lines) {
            if (line.length > 0) {
                outputChannel.appendLine(`${prefix}${line}`);
            }
        }
        return remainder;
    };

    if (qmlProcess.stdout) {
        qmlProcess.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            stdoutBuffer = flushBufferedLines(stdoutBuffer, '[stdout] ');
        });
    }

    if (qmlProcess.stderr) {
        qmlProcess.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
            stderrBuffer = flushBufferedLines(stderrBuffer, '[stderr] ');
        });
    }

    qmlProcess.on('error', (err: Error) => {
        outputChannel.appendLine(`[ERROR] Failed to launch qml.exe: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to launch qml.exe: ${err.message}`);
    });

    qmlProcess.on('exit', (code, signal) => {
        if (stdoutBuffer.length > 0) {
            outputChannel.appendLine(`[stdout] ${stdoutBuffer}`);
            stdoutBuffer = '';
        }
        if (stderrBuffer.length > 0) {
            outputChannel.appendLine(`[stderr] ${stderrBuffer}`);
            stderrBuffer = '';
        }
        outputChannel.appendLine(`---`);
        outputChannel.appendLine(`[QML Preview] Process exited with code ${code}, signal ${signal}`);
    });

    vscode.window.setStatusBarMessage(
        `$(play) QML Preview: ${selectedTarget.name}`,
        4000
    );
}

export function deactivate() {
    if (qmlProcess && !qmlProcess.killed) {
        qmlProcess.kill();
    }
}
