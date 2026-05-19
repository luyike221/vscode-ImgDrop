"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// ─── Variable Resolution ──────────────────────────────────────────────────────
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
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? fileDir;
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
// ─── Clipboard Image Reading ──────────────────────────────────────────────────
async function getClipboardImageBuffer(format, quality) {
    const platform = process.platform;
    try {
        if (platform === 'win32') {
            return await getClipboardImageWindows(format, quality);
        }
        else if (platform === 'darwin') {
            return await getClipboardImageMac(format, quality);
        }
        else {
            return await getClipboardImageLinux(format, quality);
        }
    }
    catch (err) {
        console.error('Failed to read clipboard image:', err);
        return null;
    }
}
async function getClipboardImageWindows(format, quality) {
    // Use PowerShell to read clipboard image and output as base64
    const qualityParam = format === 'jpg' ? quality : 100;
    const psFormat = format === 'jpg' ? 'Jpeg' : format === 'webp' ? 'Png' : 'Png'; // GDI+ has limited format support
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
[Convert]::ToBase64String($ms.ToArray())
`;
    const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -Command "${script.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`, { maxBuffer: 50 * 1024 * 1024 });
    const trimmed = stdout.trim();
    if (!trimmed) {
        return null;
    }
    return Buffer.from(trimmed, 'base64');
}
async function getClipboardImageMac(format, quality) {
    const ext = format === 'jpg' ? 'jpeg' : format;
    const tmpFile = path.join(require('os').tmpdir(), `md_paste_tmp.${ext}`);
    try {
        await execAsync(`osascript -e 'set the clipboard to (the clipboard as «class PNGf»)'`);
        const script = format === 'png'
            ? `osascript -e 'set imgData to the clipboard as «class PNGf»' -e 'set f to open for access POSIX file "${tmpFile}" with write permission' -e 'write imgData to f' -e 'close access f'`
            : `screencapture -c - | sips -s format ${ext} --out "${tmpFile}" /dev/stdin`;
        // Use pngpaste if available (more reliable on macOS)
        try {
            await execAsync(`which pngpaste`);
            await execAsync(`pngpaste "${tmpFile}"`);
        }
        catch {
            await execAsync(`osascript -e 'set imgData to the clipboard as «class PNGf»' \
        -e 'set f to open for access POSIX file "${tmpFile}" with write permission' \
        -e 'write imgData to f' \
        -e 'close access f'`);
            if (format !== 'png') {
                await execAsync(`sips -s format ${ext} "${tmpFile}" --out "${tmpFile}"`);
            }
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
    const tmpFile = path.join(require('os').tmpdir(), `md_paste_tmp.${ext}`);
    try {
        // Try xclip first, then xsel
        try {
            await execAsync(`xclip -selection clipboard -t image/png -o > "${tmpFile}.png"`);
        }
        catch {
            await execAsync(`xsel --clipboard --output > "${tmpFile}.png"`);
        }
        if (format !== 'png') {
            await execAsync(`convert "${tmpFile}.png" -quality ${quality} "${tmpFile}"`);
            try {
                fs.unlinkSync(`${tmpFile}.png`);
            }
            catch { /* ignore */ }
        }
        else {
            fs.renameSync(`${tmpFile}.png`, tmpFile);
        }
        return fs.readFileSync(tmpFile);
    }
    finally {
        try {
            fs.unlinkSync(tmpFile);
        }
        catch { /* ignore */ }
        try {
            fs.unlinkSync(`${tmpFile}.png`);
        }
        catch { /* ignore */ }
    }
}
// ─── Core Paste Logic ─────────────────────────────────────────────────────────
async function pasteImage(editor) {
    const config = vscode.workspace.getConfiguration('mdImagePaste');
    const saveDirectory = config.get('saveDirectory', '${fileDir}/assets/images');
    const fileNamePattern = config.get('fileNamePattern', '${date}_${random}');
    const imageFormat = config.get('imageFormat', 'png');
    const jpgQuality = config.get('jpgQuality', 85);
    const mdLinkStyle = config.get('mdLinkStyle', 'relative');
    const mdTemplate = config.get('mdTemplate', '![${fileName}](${imagePath})');
    const autoCreateDir = config.get('autoCreateDir', true);
    const showNotification = config.get('showNotification', true);
    const mdFilePath = editor.document.uri.fsPath;
    // Resolve save directory path
    const resolvedDir = resolveVariables(saveDirectory, mdFilePath);
    // Ensure directory exists
    if (!fs.existsSync(resolvedDir)) {
        if (autoCreateDir) {
            fs.mkdirSync(resolvedDir, { recursive: true });
        }
        else {
            vscode.window.showErrorMessage(`Save directory does not exist: ${resolvedDir}`);
            return;
        }
    }
    // Read clipboard image
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading clipboard...', cancellable: false }, async () => {
        const imageBuffer = await getClipboardImageBuffer(imageFormat, jpgQuality);
        if (!imageBuffer || imageBuffer.length === 0) {
            // No image in clipboard — fall through to default paste behavior
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            return;
        }
        // Build file name
        const resolvedName = resolveVariables(fileNamePattern, mdFilePath);
        const ext = imageFormat === 'jpg' ? 'jpg' : imageFormat === 'webp' ? 'webp' : 'png';
        const imageFileName = `${resolvedName}.${ext}`;
        const imageSavePath = path.join(resolvedDir, imageFileName);
        // Save image
        fs.writeFileSync(imageSavePath, imageBuffer);
        // Build Markdown link path
        let imageLinkPath;
        if (mdLinkStyle === 'absolute') {
            imageLinkPath = imageSavePath.replace(/\\/g, '/');
        }
        else {
            imageLinkPath = path.relative(path.dirname(mdFilePath), imageSavePath).replace(/\\/g, '/');
        }
        // Build MD snippet using template
        const mdSnippet = mdTemplate
            .replace(/\$\{fileName\}/g, path.basename(imageFileName, `.${ext}`))
            .replace(/\$\{fileNameWithExt\}/g, imageFileName)
            .replace(/\$\{imagePath\}/g, imageLinkPath);
        // Insert into editor
        await editor.edit(editBuilder => {
            editBuilder.replace(editor.selection, mdSnippet);
        });
        if (showNotification) {
            vscode.window.showInformationMessage(`✅ Image saved: ${imageSavePath}`);
        }
    });
}
// ─── Extension Lifecycle ──────────────────────────────────────────────────────
function activate(context) {
    console.log('md-image-paste extension activated');
    // Register paste command
    const pasteCmd = vscode.commands.registerCommand('mdImagePaste.pasteImage', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor.');
            return;
        }
        if (editor.document.languageId !== 'markdown') {
            // Not a markdown file, use default paste
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            return;
        }
        try {
            await pasteImage(editor);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to paste image: ${err?.message ?? err}`);
        }
    });
    // Register open settings command
    const settingsCmd = vscode.commands.registerCommand('mdImagePaste.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'mdImagePaste');
    });
    context.subscriptions.push(pasteCmd, settingsCmd);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map