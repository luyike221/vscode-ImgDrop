"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const child_process_1 = require("child_process");
const util_1 = require("util");
const config_1 = require("./oss/config");
const upload_1 = require("./oss/upload");
const secrets_1 = require("./oss/secrets");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
// ─── Environment ───────────────────────────────────────────────────────────────
function isWsl() {
    if (process.env.WSL_DISTRO_NAME) {
        return true;
    }
    try {
        return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    }
    catch {
        return false;
    }
}
function useWindowsClipboard() {
    return process.platform === 'win32' || (process.platform === 'linux' && isWsl());
}
function windowsPathToLocalPath(winPath) {
    const normalized = winPath.trim().replace(/^file:\/\//i, '');
    const match = normalized.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (match && process.platform === 'linux') {
        return path.join('/mnt', match[1].toLowerCase(), match[2].replace(/\\/g, '/'));
    }
    return normalized;
}
function resolveExistingImagePath(rawPath) {
    const candidates = [
        rawPath.trim(),
        windowsPathToLocalPath(rawPath.trim()),
        path.resolve(rawPath.trim()),
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p) && IMAGE_EXTS.has(path.extname(p).toLowerCase())) {
            return p;
        }
    }
    return null;
}
// ─── Variable Resolution ───────────────────────────────────────────────────────
function getMdFilePath(editor) {
    const uri = editor.document.uri;
    if (uri.scheme === 'file') {
        return uri.fsPath;
    }
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();
    const base = path.basename(editor.document.fileName, path.extname(editor.document.fileName)) || 'untitled';
    return path.join(workspaceDir, `${base}.md`);
}
function resolveVariables(template, mdFilePath) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const year = String(now.getFullYear());
    const month = pad(now.getMonth() + 1);
    const day = pad(now.getDate());
    const date = `${year}${month}${day}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const random = Math.random().toString(36).slice(2, 8);
    const fileDir = path.dirname(mdFilePath);
    const fileName = path.basename(mdFilePath, path.extname(mdFilePath));
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? fileDir;
    return template
        .replace(/\$\{fileDir\}/g, fileDir)
        .replace(/\$\{workspaceDir\}/g, workspaceDir)
        .replace(/\$\{fileName\}/g, fileName)
        .replace(/\$\{year\}/g, year)
        .replace(/\$\{month\}/g, month)
        .replace(/\$\{day\}/g, day)
        .replace(/\$\{date\}/g, date)
        .replace(/\$\{time\}/g, time)
        .replace(/\$\{random\}/g, random);
}
// ─── PowerShell (Windows / WSL) ──────────────────────────────────────────────
async function runPowerShellScript(script) {
    const tmpDir = os.tmpdir();
    const scriptPath = path.join(tmpDir, `imgdrop-${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, script, 'utf8');
    const psExe = process.platform === 'linux' ? 'powershell.exe' : 'powershell';
    const scriptArg = process.platform === 'linux'
        ? (await execFileAsync('wslpath', ['-w', scriptPath]).then(r => r.stdout.trim()).catch(() => scriptPath))
        : scriptPath;
    try {
        const { stdout, stderr } = await execFileAsync(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptArg], { maxBuffer: 50 * 1024 * 1024, windowsHide: true });
        return { stdout, stderr, code: 0 };
    }
    catch (err) {
        return {
            stdout: err?.stdout?.toString() ?? '',
            stderr: err?.stderr?.toString() ?? '',
            code: err?.code ?? 1,
        };
    }
    finally {
        try {
            fs.unlinkSync(scriptPath);
        }
        catch { /* ignore */ }
    }
}
async function getClipboardImageWindows(format, quality) {
    const qualityParam = format === 'jpg' ? quality : 100;
    const psFormat = format === 'jpg' ? 'Jpeg' : 'Png';
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 1 }
$ms = New-Object System.IO.MemoryStream
$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatDescription -eq '${psFormat}' }
if ($encoder -eq $null) {
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
} else {
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${qualityParam})
  $img.Save($ms, $encoder, $params)
}
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`;
    const { stdout, code } = await runPowerShellScript(script);
    if (code !== 0 || !stdout.trim()) {
        return null;
    }
    return Buffer.from(stdout.trim(), 'base64');
}
async function getClipboardFilePathsWindows() {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($list -eq $null -or $list.Count -eq 0) { exit 1 }
foreach ($item in $list) { [Console]::Out.WriteLine($item) }
`;
    const { stdout, code } = await runPowerShellScript(script);
    if (code !== 0) {
        return [];
    }
    return stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}
async function getClipboardTextWindows() {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Windows.Forms.Clipboard]::GetText()
if ($text) { [Console]::Out.Write($text) }
`;
    const { stdout } = await runPowerShellScript(script);
    return stdout;
}
// ─── Clipboard Image Reading ──────────────────────────────────────────────────
async function getClipboardImageMac(format, _quality) {
    const ext = format === 'jpg' ? 'jpeg' : format;
    const tmpFile = path.join(os.tmpdir(), `imgdrop_tmp.${ext}`);
    try {
        try {
            await execFileAsync('which', ['pngpaste']);
            await execFileAsync('pngpaste', [tmpFile]);
        }
        catch {
            await execFileAsync('osascript', [
                '-e', 'set imgData to the clipboard as «class PNGf»',
                '-e', `set f to open for access POSIX file "${tmpFile}" with write permission`,
                '-e', 'write imgData to f',
                '-e', 'close access f',
            ]);
            if (format !== 'png') {
                await execFileAsync('sips', ['-s', 'format', ext, tmpFile, '--out', tmpFile]);
            }
        }
        if (!fs.existsSync(tmpFile)) {
            return null;
        }
        return fs.readFileSync(tmpFile);
    }
    finally {
        try {
            fs.unlinkSync(tmpFile);
        }
        catch { /* ignore */ }
    }
}
async function getClipboardImageLinux(format, quality) {
    const ext = format === 'jpg' ? 'jpeg' : format;
    const tmpFile = path.join(os.tmpdir(), `imgdrop_tmp.${ext}`);
    const tmpPng = `${tmpFile}.png`;
    try {
        try {
            await execFileAsync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { maxBuffer: 50 * 1024 * 1024 })
                .then(r => fs.writeFileSync(tmpPng, r.stdout));
        }
        catch {
            await execFileAsync('xsel', ['--clipboard', '--output'], { maxBuffer: 50 * 1024 * 1024 })
                .then(r => fs.writeFileSync(tmpPng, r.stdout));
        }
        if (!fs.existsSync(tmpPng) || fs.statSync(tmpPng).size === 0) {
            return null;
        }
        if (format !== 'png') {
            await execFileAsync('convert', [tmpPng, '-quality', String(quality), tmpFile]);
            return fs.readFileSync(tmpFile);
        }
        return fs.readFileSync(tmpPng);
    }
    finally {
        try {
            fs.unlinkSync(tmpFile);
        }
        catch { /* ignore */ }
        try {
            fs.unlinkSync(tmpPng);
        }
        catch { /* ignore */ }
    }
}
async function readImageFromFilePaths(paths) {
    for (const raw of paths) {
        const resolved = resolveExistingImagePath(raw);
        if (resolved) {
            return fs.readFileSync(resolved);
        }
    }
    return null;
}
async function getClipboardImageBuffer(format, quality) {
    try {
        if (useWindowsClipboard()) {
            const bitmap = await getClipboardImageWindows(format, quality);
            if (bitmap && bitmap.length > 0) {
                return bitmap;
            }
            const filePaths = await getClipboardFilePathsWindows();
            const fromFiles = await readImageFromFilePaths(filePaths);
            if (fromFiles) {
                return fromFiles;
            }
            const text = (await getClipboardTextWindows()).trim();
            if (text) {
                const fromText = resolveExistingImagePath(text);
                if (fromText) {
                    return fs.readFileSync(fromText);
                }
            }
            return null;
        }
        if (process.platform === 'darwin') {
            return await getClipboardImageMac(format, quality);
        }
        return await getClipboardImageLinux(format, quality);
    }
    catch (err) {
        console.error('Failed to read clipboard image:', err);
        return null;
    }
}
// ─── Core Paste Logic ─────────────────────────────────────────────────────────
async function pasteImage(editor, extensionContext) {
    const config = vscode.workspace.getConfiguration('imgDrop');
    const storageMode = (0, config_1.getStorageMode)(config);
    const saveDirectory = config.get('saveDirectory', '${fileDir}/assets/images');
    const fileNamePattern = config.get('fileNamePattern', '${date}_${random}');
    const imageFormat = config.get('imageFormat', 'png');
    const jpgQuality = config.get('jpgQuality', 85);
    const mdLinkStyle = config.get('mdLinkStyle', 'relative');
    const mdTemplate = config.get('mdTemplate', '![${fileName}](${imagePath})');
    const autoCreateDir = config.get('autoCreateDir', true);
    const showNotification = config.get('showNotification', true);
    const objectPrefix = config.get('oss.objectPrefix', 'imgdrop/');
    const mdFilePath = getMdFilePath(editor);
    const resolveForMd = (template) => resolveVariables(template, mdFilePath);
    if (storageMode === 'oss') {
        const hasSecret = Boolean(await (0, secrets_1.getOssAccessKeySecret)(extensionContext.secrets));
        const missing = (0, config_1.listMissingOssFields)(config, hasSecret);
        if (missing.length > 0) {
            const setSecret = '设置 OSS 密钥';
            const choice = await vscode.window.showErrorMessage((0, config_1.ossConfigErrorHint)(missing), setSecret);
            if (choice === setSecret) {
                await vscode.commands.executeCommand('imgDrop.setOssSecret');
            }
            return;
        }
    }
    else {
        const resolvedDir = resolveForMd(saveDirectory);
        if (!fs.existsSync(resolvedDir)) {
            if (autoCreateDir) {
                fs.mkdirSync(resolvedDir, { recursive: true });
            }
            else {
                vscode.window.showErrorMessage(`Save directory does not exist: ${resolvedDir}`);
                return;
            }
        }
    }
    const progressTitle = storageMode === 'oss' ? 'Reading clipboard & uploading to OSS...' : 'Reading clipboard...';
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: false }, async () => {
        const imageBuffer = await getClipboardImageBuffer(imageFormat, jpgQuality);
        if (!imageBuffer || imageBuffer.length === 0) {
            const hint = useWindowsClipboard()
                ? '请用截图工具复制图片（Ctrl+C），或在资源管理器中复制图片文件后再粘贴。'
                : '请确认剪贴板中有图片，且已安装 xclip（Linux）或 pngpaste（macOS）。';
            const choice = await vscode.window.showWarningMessage(`未检测到剪贴板图片，无法插入。${hint}`, '仍要普通粘贴');
            if (choice === '仍要普通粘贴') {
                await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            }
            return;
        }
        const resolvedName = resolveForMd(fileNamePattern);
        const ext = imageFormat === 'jpg' ? 'jpg' : imageFormat === 'webp' ? 'webp' : 'png';
        const imageFileName = `${resolvedName}.${ext}`;
        let imageLinkPath;
        let notifyMessage;
        if (storageMode === 'oss') {
            const ossSettings = await (0, config_1.loadOssSettings)(config, extensionContext.secrets);
            if (!ossSettings) {
                vscode.window.showErrorMessage((0, config_1.ossConfigErrorHint)(['OSS 配置']));
                return;
            }
            const objectKey = (0, config_1.buildObjectKey)(objectPrefix, imageFileName, resolveForMd);
            imageLinkPath = await (0, upload_1.uploadImageToOss)(ossSettings, objectKey, imageBuffer, ext);
            notifyMessage = `Image uploaded to OSS: ${imageLinkPath}`;
        }
        else {
            const resolvedDir = resolveForMd(saveDirectory);
            const imageSavePath = path.join(resolvedDir, imageFileName);
            fs.writeFileSync(imageSavePath, imageBuffer);
            if (mdLinkStyle === 'absolute') {
                imageLinkPath = imageSavePath.replace(/\\/g, '/');
            }
            else {
                imageLinkPath = path.relative(path.dirname(mdFilePath), imageSavePath).replace(/\\/g, '/');
            }
            notifyMessage = `Image saved: ${imageSavePath}`;
        }
        const mdSnippet = mdTemplate
            .replace(/\$\{fileName\}/g, path.basename(imageFileName, `.${ext}`))
            .replace(/\$\{fileNameWithExt\}/g, imageFileName)
            .replace(/\$\{imagePath\}/g, imageLinkPath);
        await editor.edit(editBuilder => {
            if (editor.selection.isEmpty) {
                editBuilder.insert(editor.selection.active, mdSnippet);
            }
            else {
                editBuilder.replace(editor.selection, mdSnippet);
            }
        });
        if (showNotification) {
            vscode.window.showInformationMessage(notifyMessage);
        }
    });
}
// ─── Extension Lifecycle ──────────────────────────────────────────────────────
function activate(context) {
    console.log('ImgDrop extension activated');
    const pasteCmd = vscode.commands.registerCommand('imgDrop.pasteImage', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor.');
            return;
        }
        if (editor.document.languageId !== 'markdown') {
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            return;
        }
        try {
            await pasteImage(editor, context);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to paste image: ${msg}`);
        }
    });
    const settingsCmd = vscode.commands.registerCommand('imgDrop.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'imgDrop');
    });
    const setOssSecretCmd = vscode.commands.registerCommand('imgDrop.setOssSecret', async () => {
        const secret = await vscode.window.showInputBox({
            title: 'ImgDrop: OSS Access Key Secret',
            prompt: '密钥将保存在 VS Code SecretStorage，不会写入 settings.json',
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : '密钥不能为空'),
        });
        if (secret === undefined) {
            return;
        }
        await (0, secrets_1.setOssAccessKeySecret)(context.secrets, secret.trim());
        vscode.window.showInformationMessage('OSS Access Key Secret 已保存。');
    });
    const clearOssSecretCmd = vscode.commands.registerCommand('imgDrop.clearOssSecret', async () => {
        const choice = await vscode.window.showWarningMessage('确定清除已保存的 OSS Access Key Secret？', '清除');
        if (choice === '清除') {
            await (0, secrets_1.clearOssAccessKeySecret)(context.secrets);
            vscode.window.showInformationMessage('OSS Access Key Secret 已清除。');
        }
    });
    context.subscriptions.push(pasteCmd, settingsCmd, setOssSecretCmd, clearOssSecretCmd);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map