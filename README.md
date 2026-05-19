# ImgDrop

在 VSCode 中编辑 Markdown 时，按 **Ctrl+V**（Mac：**Cmd+V**）可将剪贴板图片保存到指定目录，并在光标处插入 Markdown 图片链接；剪贴板为文字时则正常粘贴，不影响日常编辑。

---

## 功能

- 在 `.md` 文件中拦截粘贴快捷键，自动检测剪贴板是否含图片
- 有图片：保存到配置目录，并插入 Markdown 图片链接
- 无图片：回退为普通文字粘贴
- 支持 PNG / JPG / WebP 输出
- 支持路径变量，灵活配置保存目录与文件名

---

## 平台要求

| 平台 | 依赖 |
|------|------|
| **Windows** | PowerShell（系统内置） |
| **WSL（Remote-WSL）** | 自动通过 `powershell.exe` 读取 **Windows 剪贴板**（无需 xclip） |
| **macOS** | 推荐 `pngpaste`：`brew install pngpaste`；未安装时回退 osascript |
| **Linux（原生）** | `xclip` 或 `xsel`：`sudo apt install xclip` |

> **WSL 注意**：请用 Windows 侧截图/复制（Snipaste、Win+Shift+S 等），或在资源管理器中复制图片文件。插件会识别剪贴板中的位图、文件路径或拖放列表。

---

## 使用

### 从 VSIX 安装

```bash
code --install-extension img-drop-1.1.0.vsix
```

### 本地调试

1. 克隆项目并用 VSCode 打开
2. 执行 `npm install` 与 `npm run compile`
3. 按 **F5** 启动扩展开发宿主
4. 打开任意 `.md` 文件，从截图工具复制图片后按 **Ctrl+V**

---

## 配置

在 VSCode 设置（`Ctrl+,`）中搜索 `imgDrop`。

### 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `saveDirectory` | `${fileDir}/assets/images` | 图片保存目录 |
| `fileNamePattern` | `${date}_${random}` | 文件名规则（不含扩展名） |
| `imageFormat` | `png` | 图片格式：`png` / `jpg` / `webp` |
| `jpgQuality` | `85` | JPEG 质量（1–100） |
| `mdLinkStyle` | `relative` | 链接路径：`relative` / `absolute` |
| `mdTemplate` | 见下方「Markdown 模板」 | 插入的 Markdown 模板 |
| `autoCreateDir` | `true` | 目录不存在时自动创建 |
| `showNotification` | `true` | 保存成功后弹出通知 |

### 路径变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `${fileDir}` | 当前 md 文件所在目录 | `/home/user/docs` |
| `${workspaceDir}` | 工作区根目录 | `/home/user/project` |
| `${fileName}` | 当前 md 文件名（无扩展名） | `readme` |
| `${date}` | 今天日期 | `20240519` |
| `${year}` | 年份 | `2024` |
| `${month}` | 月份 | `05` |
| `${day}` | 日 | `19` |
| `${time}` | 时间 HHMMSS | `143022` |
| `${random}` | 6 位随机字符串 | `a3f9xz` |

### Markdown 模板

`mdTemplate` 默认值为 Markdown 图片语法，占位符包括 `${fileName}`、`${imagePath}`、`${fileNameWithExt}`，完整默认值见 `package.json`。

### 配置示例

```jsonc
// settings.json
{
  "imgDrop.saveDirectory": "${fileDir}/assets/${year}/${month}",
  "imgDrop.fileNamePattern": "${fileName}_${time}",
  "imgDrop.imageFormat": "jpg",
  "imgDrop.jpgQuality": 90,
  "imgDrop.mdLinkStyle": "absolute"
}
```

---

## 开发

### 项目结构

```
vscode_plugin/
├── src/extension.ts      # 插件主逻辑
├── package.json          # 清单（快捷键、配置、命令）
├── tsconfig.json
├── .vscode/
│   ├── launch.json       # F5 调试
│   └── tasks.json        # 编译任务
└── Readme.md
```

### 核心逻辑

- **快捷键**：仅在 `editorLangId == markdown` 时绑定 `Ctrl+V`，其他文件不受影响
- **剪贴板读取**：Windows / WSL 用 PowerShell；macOS 优先 `pngpaste`；Linux 用 `xclip` / `xsel`
- **无图片时**：提示用户，可选择普通粘贴

### 编译与打包

```bash
npm install
npm run compile

npm install -g @vscode/vsce
vsce package --allow-missing-repository
code --install-extension img-drop-1.1.0.vsix
```
