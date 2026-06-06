import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

let selectedQmlFile: string | undefined; // absolute path
let qmlFileStatusBar: vscode.StatusBarItem;
let previewStatusBar: vscode.StatusBarItem;
let qmlProcess: ChildProcess | undefined;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('QML Preview');
    context.subscriptions.push(outputChannel);

    qmlFileStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    qmlFileStatusBar.command = 'qmlPreview.selectQmlFile';
    qmlFileStatusBar.tooltip = 'Click to select QML file for preview';
    context.subscriptions.push(qmlFileStatusBar);

    previewStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    previewStatusBar.command = 'qmlPreview.preview';
    previewStatusBar.text = '$(play) Preview';
    previewStatusBar.tooltip = 'Run QML Preview';
    context.subscriptions.push(previewStatusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('qmlPreview.selectQmlFile', async () => {
            const picked = await pickQmlFile();
            if (picked) {
                selectedQmlFile = picked;
                updateStatusBar();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('qmlPreview.preview', async () => {
            await runPreview();
        })
    );

    initSelectedQmlFile();
    updateStatusBar();
}

function getConfiguredQmlFile(): string {
    const config = vscode.workspace.getConfiguration('qmlPreview');
    return (config.get<string>('previewQmlFile') ?? '').trim();
}

async function initSelectedQmlFile(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }
    const workspaceRoot = folders[0].uri.fsPath;

    const configured = getConfiguredQmlFile();
    if (configured) {
        const absPath = path.resolve(workspaceRoot, configured);
        if (fs.existsSync(absPath)) {
            selectedQmlFile = absPath;
            updateStatusBar();
            return;
        }
    }

    // Default: find Main.qml
    const uris = await vscode.workspace.findFiles('**/*.qml', '{**/node_modules/**,**/build/**}', 200);
    const mainQml = uris.find(u => path.basename(u.fsPath).toLowerCase() === 'main.qml');
    if (mainQml) {
        selectedQmlFile = mainQml.fsPath;
        updateStatusBar();
    }
}

async function pickQmlFile(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    const workspaceRoot = folders?.[0].uri.fsPath ?? '';

    const uris = await vscode.workspace.findFiles('**/*.qml', '{**/node_modules/**,**/build/**}', 500);

    if (uris.length === 0) {
        vscode.window.showWarningMessage('No QML files found in workspace.');
        return undefined;
    }

    const items = uris.map(u => {
        const rel = path.relative(workspaceRoot, u.fsPath).replace(/\\/g, '/');
        return { label: path.basename(u.fsPath), description: rel, fsPath: u.fsPath };
    }).sort((a, b) => {
        const aIsMain = a.label.toLowerCase() === 'main.qml';
        const bIsMain = b.label.toLowerCase() === 'main.qml';
        if (aIsMain && !bIsMain) { return -1; }
        if (!aIsMain && bIsMain) { return 1; }
        return a.description.localeCompare(b.description);
    });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select QML file for preview'
    });

    return picked?.fsPath;
}

function updateStatusBar() {
    const folders = vscode.workspace.workspaceFolders;
    const workspaceRoot = folders?.[0].uri.fsPath ?? '';

    if (selectedQmlFile) {
        const rel = path.relative(workspaceRoot, selectedQmlFile).replace(/\\/g, '/');
        qmlFileStatusBar.text = `$(file-code) ${rel}`;
    } else {
        qmlFileStatusBar.text = '$(file-code) Select QML file';
    }
    qmlFileStatusBar.show();
    previewStatusBar.show();
}

function findLatestQtKitInRoot(installRoot: string): string | null {
    try {
        const versionDirs = fs.readdirSync(installRoot)
            .filter(d => /^\d+\.\d+/.test(d))
            .sort((a, b) => {
                const av = a.split('.').map(Number);
                const bv = b.split('.').map(Number);
                for (let i = 0; i < Math.max(av.length, bv.length); i++) {
                    if ((bv[i] ?? 0) !== (av[i] ?? 0)) { return (bv[i] ?? 0) - (av[i] ?? 0); }
                }
                return 0;
            });

        const qmlBin = process.platform === 'win32' ? 'qml.exe' : 'qml';
        for (const ver of versionDirs) {
            const verPath = path.join(installRoot, ver);
            const kitDirs = fs.readdirSync(verPath).filter(d =>
                fs.existsSync(path.join(verPath, d, 'bin', qmlBin))
            );
            if (kitDirs.length > 0) {
                const preferred = kitDirs.find(d => d.includes('64')) ?? kitDirs[0];
                const result = path.join(verPath, preferred);
                outputChannel.appendLine(`[QML Preview] Qt extension: found kit ${result}`);
                return result;
            }
        }
    } catch (err) {
        outputChannel.appendLine(`[QML Preview] Error scanning Qt installation root: ${err}`);
    }
    return null;
}

async function extractQtPathFromQtExtension(): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('qt-core');

    // additionalQtPaths: array of paths to qmake/qtpaths executables
    const additionalPaths = config.get<string[]>('additionalQtPaths') ?? [];
    for (const p of additionalPaths) {
        if (!p) { continue; }
        const binDir = path.dirname(p);
        const qtRoot = path.dirname(binDir); // strip bin/
        outputChannel.appendLine(`[QML Preview] Qt extension additionalQtPaths -> ${qtRoot}`);
        return qtRoot;
    }

    // qtInstallationRoot: e.g. C:/Qt — scan for latest version + kit
    const installRoot = (config.get<string>('qtInstallationRoot') ?? '').trim();
    if (installRoot && fs.existsSync(installRoot)) {
        outputChannel.appendLine(`[QML Preview] Qt extension qtInstallationRoot: ${installRoot}`);
        return findLatestQtKitInRoot(installRoot);
    }

    return null;
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

        for (const line of lines) {
            if (line.startsWith('Qt6_DIR:PATH=') || line.startsWith('Qt6_DIR:STRING=')) {
                let qtPath = line.split('=')[1].trim();
                if (qtPath) {
                    outputChannel.appendLine(`[QML Preview] Found Qt6_DIR: ${qtPath}`);
                    qtPath = qtPath.replace(/\\/g, '/');
                    if (qtPath.endsWith('/lib/cmake/Qt6')) {
                        qtPath = qtPath.substring(0, qtPath.length - '/lib/cmake/Qt6'.length);
                        outputChannel.appendLine(`[QML Preview] Extracted Qt root: ${qtPath}`);
                    }
                    return qtPath;
                }
            }
        }

        for (const line of lines) {
            if (line.startsWith('Qt5_DIR:PATH=') || line.startsWith('Qt5_DIR:STRING=')) {
                let qtPath = line.split('=')[1].trim();
                if (qtPath) {
                    outputChannel.appendLine(`[QML Preview] Found Qt5_DIR: ${qtPath}`);
                    qtPath = qtPath.replace(/\\/g, '/');
                    if (qtPath.endsWith('/lib/cmake/Qt5')) {
                        qtPath = qtPath.substring(0, qtPath.length - '/lib/cmake/Qt5'.length);
                        outputChannel.appendLine(`[QML Preview] Extracted Qt root: ${qtPath}`);
                    }
                    return qtPath;
                }
            }
        }

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

function getQmlExecutable(): string {
    const config = vscode.workspace.getConfiguration('qmlPreview');
    return (config.get<string>('qmlExecutable') ?? '').trim();
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
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('No workspace folder found.');
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    // Resolve from config if not yet selected
    if (!selectedQmlFile) {
        const configured = getConfiguredQmlFile();
        if (configured) {
            const absPath = path.resolve(workspaceRoot, configured);
            if (fs.existsSync(absPath)) {
                selectedQmlFile = absPath;
                updateStatusBar();
            }
        }
    }

    // Prompt user if still unset
    if (!selectedQmlFile) {
        const picked = await pickQmlFile();
        if (!picked) {
            vscode.window.showWarningMessage('No QML file selected for preview.');
            return;
        }
        selectedQmlFile = picked;
        updateStatusBar();
    }

    // Kill previous process if still running
    if (qmlProcess && !qmlProcess.killed) {
        qmlProcess.kill();
        qmlProcess = undefined;
    }

    outputChannel.clear();
    outputChannel.show();
    outputChannel.appendLine(`[QML Preview] Searching for Qt path...`);

    const qtPath = await extractQtPathFromCMakeCache()
        ?? await extractQtPathFromQtExtension();

    const qmlBin = process.platform === 'win32' ? 'qml.exe' : 'qml';
    let qmlExe: string;
    if (qtPath) {
        qmlExe = path.join(qtPath, 'bin', qmlBin);
        outputChannel.appendLine(`[QML Preview] Resolved qml executable: ${qmlExe}`);
    } else {
        qmlExe = getQmlExecutable();
        if (!qmlExe) {
            vscode.window.showErrorMessage(
                'Cannot find qml executable. Set qt-core.qtInstallationRoot in Qt extension settings, or set qmlPreview.qmlExecutable manually.'
            );
            return;
        }
        outputChannel.appendLine(`[QML Preview] Using configured qml executable: ${qmlExe}`);
    }

    // Always pass the full workspace-relative path (e.g. ui/Main.qml, not just Main.qml)
    let qmlEntry = path.relative(workspaceRoot, selectedQmlFile).replace(/\\/g, '/');
    if (!qmlEntry || qmlEntry.startsWith('..')) {
        qmlEntry = path.basename(selectedQmlFile);
        outputChannel.appendLine(
            `[QML Preview] QML file is outside workspace root, using filename: ${qmlEntry}`
        );
    }

    const buildDirName = 'build';
    const qmlArgs = ['-I', buildDirName, qmlEntry];
    const hotreload = getHotReloadEnabled();
    let launchExe = qmlExe;
    let launchArgs = [...qmlArgs];

    if (hotreload) {
        const previewExe = path.join(
            path.dirname(qmlExe),
            process.platform === 'win32' ? 'qmlpreview.exe' : 'qmlpreview'
        );
        launchExe = previewExe;
        launchArgs = [qmlExe, ...qmlArgs];
    }

    const quoteArg = (value: string) => /[\s"]/g.test(value)
        ? `"${value.replace(/"/g, '\\"')}"`
        : value;
    const fullCommand = [launchExe, ...launchArgs].map(quoteArg).join(' ');

    outputChannel.appendLine(`[QML Preview] QML file: ${selectedQmlFile}`);
    outputChannel.appendLine(`[QML Preview] Starting: ${qmlExe}`);
    outputChannel.appendLine(`[QML Preview] Args: ${qmlArgs.join(' ')}`);
    outputChannel.appendLine(`[QML Preview] Entry: ${qmlEntry}`);
    outputChannel.appendLine(`[QML Preview] Hot reload: ${hotreload ? 'on' : 'off'}`);
    outputChannel.appendLine(`[QML Preview] Full command: ${fullCommand}`);
    outputChannel.appendLine('---');
    outputChannel.appendLine(`[QML Preview] Working directory: ${workspaceRoot}`);

    const configuredQmlEnv = getConfiguredQmlEnv();
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...configuredQmlEnv };

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

    vscode.window.setStatusBarMessage(`$(play) QML Preview: ${qmlEntry}`, 4000);
}

export function deactivate() {
    if (qmlProcess && !qmlProcess.killed) {
        qmlProcess.kill();
    }
}
