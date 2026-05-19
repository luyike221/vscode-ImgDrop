import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

// ─── Environment ───────────────────────────────────────────────────────────────

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function useWindowsClipboard(): boolean {
  return process.platform === 'win32' || (process.platform === 'linux' && isWsl());
}

function windowsPathToLocalPath(winPath: string): string {
  const normalized = winPath.trim().replace(/^file:\/\//i, '');
  const match = normalized.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (match && process.platform === 'linux') {
    return path.join('/mnt', match[1].toLowerCase(), match[2].replace(/\\/g, '/'));
  }
  return normalized;
}

function resolveExistingImagePath(rawPath: string): string | null {
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

function getMdFilePath(editor: vscode.TextEditor): string {
  const uri = editor.document.uri;
  if (uri.scheme === 'file') {
    return uri.fsPath;
  }
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();
  const base = path.basename(editor.document.fileName, path.extname(editor.document.fileName)) || 'untitled';
  return path.join(workspaceDir, `${base}.md`);
}

function resolveVariables(template: string, mdFilePath: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

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

async function runPowerShellScript(script: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const tmpDir = os.tmpdir();
  const scriptPath = path.join(tmpDir, `imgdrop-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');

  const psExe = process.platform === 'linux' ? 'powershell.exe' : 'powershell';
  const scriptArg = process.platform === 'linux'
    ? (await execFileAsync('wslpath', ['-w', scriptPath]).then(r => r.stdout.trim()).catch(() => scriptPath))
    : scriptPath;

  try {
    const { stdout, stderr } = await execFileAsync(
      psExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptArg],
      { maxBuffer: 50 * 1024 * 1024, windowsHide: true }
    );
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return {
      stdout: err?.stdout?.toString() ?? '',
      stderr: err?.stderr?.toString() ?? '',
      code: err?.code ?? 1,
    };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

async function getClipboardImageWindows(format: string, quality: number): Promise<Buffer | null> {
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

async function getClipboardFilePathsWindows(): Promise<string[]> {
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

async function getClipboardTextWindows(): Promise<string> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Windows.Forms.Clipboard]::GetText()
if ($text) { [Console]::Out.Write($text) }
`;

  const { stdout } = await runPowerShellScript(script);
  return stdout;
}

// ─── Clipboard Image Reading ──────────────────────────────────────────────────

async function getClipboardImageMac(format: string, _quality: number): Promise<Buffer | null> {
  const ext = format === 'jpg' ? 'jpeg' : format;
  const tmpFile = path.join(os.tmpdir(), `imgdrop_tmp.${ext}`);

  try {
    try {
      await execFileAsync('which', ['pngpaste']);
      await execFileAsync('pngpaste', [tmpFile]);
    } catch {
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
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function getClipboardImageLinux(format: string, quality: number): Promise<Buffer | null> {
  const ext = format === 'jpg' ? 'jpeg' : format;
  const tmpFile = path.join(os.tmpdir(), `imgdrop_tmp.${ext}`);
  const tmpPng = `${tmpFile}.png`;

  try {
    try {
      await execFileAsync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { maxBuffer: 50 * 1024 * 1024 })
        .then(r => fs.writeFileSync(tmpPng, r.stdout));
    } catch {
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
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPng); } catch { /* ignore */ }
  }
}

async function readImageFromFilePaths(paths: string[]): Promise<Buffer | null> {
  for (const raw of paths) {
    const resolved = resolveExistingImagePath(raw);
    if (resolved) {
      return fs.readFileSync(resolved);
    }
  }
  return null;
}

async function getClipboardImageBuffer(format: string, quality: number): Promise<Buffer | null> {
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
  } catch (err) {
    console.error('Failed to read clipboard image:', err);
    return null;
  }
}

// ─── Core Paste Logic ─────────────────────────────────────────────────────────

async function pasteImage(editor: vscode.TextEditor): Promise<void> {
  const config = vscode.workspace.getConfiguration('imgDrop');

  const saveDirectory = config.get<string>('saveDirectory', '${fileDir}/assets/images');
  const fileNamePattern = config.get<string>('fileNamePattern', '${date}_${random}');
  const imageFormat = config.get<string>('imageFormat', 'png');
  const jpgQuality = config.get<number>('jpgQuality', 85);
  const mdLinkStyle = config.get<string>('mdLinkStyle', 'relative');
  const mdTemplate = config.get<string>('mdTemplate', '![${fileName}](${imagePath})');
  const autoCreateDir = config.get<boolean>('autoCreateDir', true);
  const showNotification = config.get<boolean>('showNotification', true);

  const mdFilePath = getMdFilePath(editor);
  const resolvedDir = resolveVariables(saveDirectory, mdFilePath);

  if (!fs.existsSync(resolvedDir)) {
    if (autoCreateDir) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    } else {
      vscode.window.showErrorMessage(`Save directory does not exist: ${resolvedDir}`);
      return;
    }
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reading clipboard...', cancellable: false },
    async () => {
      const imageBuffer = await getClipboardImageBuffer(imageFormat, jpgQuality);

      if (!imageBuffer || imageBuffer.length === 0) {
        const hint = useWindowsClipboard()
          ? '请用截图工具复制图片（Ctrl+C），或在资源管理器中复制图片文件后再粘贴。'
          : '请确认剪贴板中有图片，且已安装 xclip（Linux）或 pngpaste（macOS）。';
        const choice = await vscode.window.showWarningMessage(
          `未检测到剪贴板图片，无法插入。${hint}`,
          '仍要普通粘贴'
        );
        if (choice === '仍要普通粘贴') {
          await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        }
        return;
      }

      const resolvedName = resolveVariables(fileNamePattern, mdFilePath);
      const ext = imageFormat === 'jpg' ? 'jpg' : imageFormat === 'webp' ? 'webp' : 'png';
      const imageFileName = `${resolvedName}.${ext}`;
      const imageSavePath = path.join(resolvedDir, imageFileName);

      fs.writeFileSync(imageSavePath, imageBuffer);

      let imageLinkPath: string;
      if (mdLinkStyle === 'absolute') {
        imageLinkPath = imageSavePath.replace(/\\/g, '/');
      } else {
        imageLinkPath = path.relative(path.dirname(mdFilePath), imageSavePath).replace(/\\/g, '/');
      }

      const mdSnippet = mdTemplate
        .replace(/\$\{fileName\}/g, path.basename(imageFileName, `.${ext}`))
        .replace(/\$\{fileNameWithExt\}/g, imageFileName)
        .replace(/\$\{imagePath\}/g, imageLinkPath);

      await editor.edit(editBuilder => {
        if (editor.selection.isEmpty) {
          editBuilder.insert(editor.selection.active, mdSnippet);
        } else {
          editBuilder.replace(editor.selection, mdSnippet);
        }
      });

      if (showNotification) {
        vscode.window.showInformationMessage(`Image saved: ${imageSavePath}`);
      }
    }
  );
}

// ─── Extension Lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
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
      await pasteImage(editor);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to paste image: ${msg}`);
    }
  });

  const settingsCmd = vscode.commands.registerCommand('imgDrop.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'imgDrop');
  });

  context.subscriptions.push(pasteCmd, settingsCmd);
}

export function deactivate() {}
