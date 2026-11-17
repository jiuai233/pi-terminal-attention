# pi-terminal-attention

跨平台的 Pi 终端状态与提醒扩展，支持 macOS（Ghostty 等）和 Windows（Windows Terminal / WezTerm，兼容 `pwsh` 与 `cmd`）。

## 功能

- **标签页动态指示与任务主题**：显示文件夹名和简短任务标题（`π · 文件夹名 · 任务标题`）；执行期间显示 `•··` / `·•·` / `··•` 动画，任务标题结合首条消息生成并持久化到当前会话分支。
- **焦点感知徽标**：终端处于后台时触发提醒，并在标题加上状态徽标（`🔹` 完成、`🔸` 等待确认、`🔻` 出错）；切回当前标签页或输入内容后自动恢复空闲标题。
- **跨平台焦点识别**：开启终端 Focus Reporting（`DECSET 1004`），切出/切回窗口或标签页时即时响应；macOS Ghostty 额外结合 `osascript` 精确识别当前标签页 TTY，Windows 在未收到焦点事件时通过 `GetForegroundWindow` 进程链兜底。
- **音效提醒**：内置 `.wav` 音效，macOS 使用 `afplay`，Windows 调用系统 `powershell.exe` 播放 `System.Media.SoundPlayer`。
- **桌面通知**：macOS（Ghostty）与 WezTerm 发送 `OSC 777` 通知；Windows Terminal 等终端通过静音 WinRT Toast 发送原生桌面通知。

## 安装

需要 Node.js 24+ 与 Pi 1.1.0+。

```bash
pi install git:github.com/jiuai233/pi-terminal-attention
```

在 Pi 中执行 `/reload` 生效。

## 一键启动

如果未全局安装，也可以直接克隆仓库后运行启动脚本（参数会原样透传给 `pi`）：

- **macOS / Linux**：
  ```bash
  ./start.sh
  ```
- **Windows（`cmd` 与 `pwsh` 通用）**：
  ```bat
  .\start.cmd
  ```

启动脚本会检查当前用户配置中是否已安装本包，未安装时自动以 `pi -e ./src/index.ts` 加载；已安装时直接启动 `pi`，避免重复挂载。

## 环境说明

- **Windows 终端**：推荐使用 Windows Terminal（1.17+）或 WezTerm，二者均支持标签页标题和 Focus Reporting；在其中打开 `pwsh`（PowerShell 7）或 `cmd` 均可正常使用。
- **自动标题模型**：使用 `openai-codex/gpt-6.1-terra` 生成简短标签标题；未配置该模型凭据时自动跳过，仅显示 `π · <目录名>`。
