import { type Api, getSupportedThinkingLevels, type Message, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = path.resolve(EXT_DIR, "..", "sounds");
const SOUND_DONE = path.join(SOUNDS_DIR, "startup-chime.wav");
const SOUND_ERROR = path.join(SOUNDS_DIR, "error-buzz.wav");

const TITLE_PROVIDER = "openai-codex";
const TITLE_MODEL_ID = "gpt-6.1-terra";
const TITLE_ENTRY_TYPE = "ghostty-tab-title";

const LOADING_FRAMES = ["•··", "·•·", "··•"] as const;
const LOADING_INTERVAL_MS = 360;
const FOCUS_WATCH_INTERVAL_MS = 1000;
const FOCUS_ENABLE_SEQ = "\x1b[?1004h";
const FOCUS_DISABLE_SEQ = "\x1b[?1004l";
const WIN_POWERSHELL_AUMID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

type AlertKind = "done" | "blocked" | "error";
type TabPhase = "idle" | "working" | "attention";
type TerminalVisibility = "FOCUSED" | "BACKGROUND" | "OTHER";

const CONTINUATION_RE =
  /^(好|好的|可以|行|中|嗯|对|是的|没问题|继续|改吧|写吧|动手|确认|确定|试一下|跑一下|测一下|看看|再看看|就这样|ok|okay|yes|yep|y|go|done|continue|retry|sure)[!！。.~～?？\s]*$/i;

function resolveCurrentTty(): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "tty=", "-p", String(process.pid)], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    if (!out || out === "??" || out === "?") return null;
    return out.startsWith("/dev/") ? out : `/dev/${out}`;
  } catch {
    return null;
  }
}

function queryMacGhosttyVisibility(myTty: string): Promise<TerminalVisibility> {
  const escapedTty = myTty.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    '  if not (exists process "Ghostty") then return "OTHER"',
    "end tell",
    'tell application "Ghostty"',
    "  set isFront to frontmost",
    '  set focusedTty to ""',
    "  if isFront and (exists front window) then",
    "    try",
    "      set focusedTty to tty of (focused terminal of selected tab of front window)",
    "    end try",
    "  end if",
    "  set hasMine to false",
    "  repeat with w in windows",
    "    repeat with tb in tabs of w",
    "      repeat with t in terminals of tb",
    `        if (tty of t) is "${escapedTty}" then`,
    "          set hasMine to true",
    "          exit repeat",
    "        end if",
    "      end repeat",
    "      if hasMine then exit repeat",
    "    end repeat",
    "    if hasMine then exit repeat",
    "  end repeat",
    '  if not hasMine then return "OTHER"',
    `  if isFront and focusedTty is "${escapedTty}" then return "FOCUSED"`,
    '  return "BACKGROUND"',
    "end tell",
  ].join("\n");

  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 2500 }, (err, stdout) => {
      if (err) {
        resolve("OTHER");
        return;
      }
      const res = stdout.trim();
      if (res === "FOCUSED" || res === "BACKGROUND") {
        resolve(res);
      } else {
        resolve("OTHER");
      }
    });
  });
}

function queryWindowsForegroundFallback(): Promise<TerminalVisibility> {
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class PiWinFocus {",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    "}",
    "'@ -ErrorAction SilentlyContinue",
    "$hwnd = [PiWinFocus]::GetForegroundWindow()",
    "if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'BACKGROUND'; exit }",
    "$fgPid = [uint32]0",
    "[void][PiWinFocus]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)",
    "$cur = [int]$env:PI_TARGET_PID",
    "$chain = New-Object 'System.Collections.Generic.HashSet[int]'",
    "$procs = @{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.ProcessId] = [int]$_.ParentProcessId }",
    "while ($cur -gt 0 -and $chain.Add($cur)) { $cur = if ($procs.ContainsKey($cur)) { $procs[$cur] } else { 0 } }",
    "if ($chain.Contains([int]$fgPid)) { Write-Output 'FOCUSED' } else { Write-Output 'BACKGROUND' }",
  ].join("\n");

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      {
        timeout: 2500,
        windowsHide: true,
        env: { ...process.env, PI_TARGET_PID: String(process.pid) },
      },
      (err, stdout) => {
        if (err) {
          resolve("OTHER");
          return;
        }
        const res = stdout.trim();
        resolve(res === "BACKGROUND" ? "BACKGROUND" : "FOCUSED");
      },
    );
  });
}

function playSound(filePath: string): void {
  const soundPath = fs.existsSync(filePath) ? filePath : SOUND_DONE;
  if (!fs.existsSync(soundPath)) {
    if (process.stdout.isTTY) {
      try {
        process.stdout.write("\x07");
      } catch {
        // Ignore stdout write errors.
      }
    }
    return;
  }

  try {
    if (process.platform === "darwin") {
      const child = spawn("afplay", [soundPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return;
    }

    if (process.platform === "win32") {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "(New-Object System.Media.SoundPlayer $env:PI_SOUND_PATH).PlaySync()",
        ],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, PI_SOUND_PATH: soundPath },
        },
      );
      child.unref();
      return;
    }

    if (process.stdout.isTTY) {
      process.stdout.write("\x07");
    }
  } catch {
    // Ignore audio failures.
  }
}

function sanitizeOscField(raw: string, maxLen: number): string {
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/;/g, "；")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function sendOsc777Notification(title: string, body: string): void {
  const safeTitle = sanitizeOscField(title, 60) || "π";
  const safeBody = sanitizeOscField(body, 120) || "任务状态已更新";
  try {
    process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
  } catch {
    // Ignore stdout write errors.
  }
}

function sendWindowsToastNotification(title: string, body: string): void {
  const safeTitle = sanitizeOscField(title, 60) || "π";
  const safeBody = sanitizeOscField(body, 120) || "任务状态已更新";
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$t = [System.Security.SecurityElement]::Escape($env:PI_NOTIFY_TITLE)",
    "$b = [System.Security.SecurityElement]::Escape($env:PI_NOTIFY_BODY)",
    "$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()",
    "$xml.LoadXml(\"<toast><visual><binding template='ToastText02'><text id='1'>$t</text><text id='2'>$b</text></binding></visual><audio silent='true'/></toast>\")",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WIN_POWERSHELL_AUMID}').Show($toast)`,
  ].join("\n");

  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          PI_NOTIFY_TITLE: safeTitle,
          PI_NOTIFY_BODY: safeBody,
        },
      },
    );
    child.unref();
  } catch {
    // Ignore toast failures.
  }
}

function sendDesktopNotification(title: string, body: string): void {
  if (process.platform === "win32" && process.env.TERM_PROGRAM !== "WezTerm") {
    sendWindowsToastNotification(title, body);
    return;
  }
  sendOsc777Notification(title, body);
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text?: string } => Boolean(part && typeof part === "object"))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function normalizeTopic(raw: string): string {
  let text = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'`“”‘’《》【】\[\]()（）]+|["'`“”‘’《》【】\[\]()（）.。!！?？:：]+$/g, "")
    .replace(/^(?:π|pi)\s*[·•\-—:|]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length > 18) {
    text = text.slice(0, 18).trim();
  }
  return text;
}

function findTerraModel(ctx: ExtensionContext): Model<Api> | undefined {
  const model = ctx.modelRegistry.find(TITLE_PROVIDER, TITLE_MODEL_ID);
  if (!model) return undefined;
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
  return model;
}

function pickLowestThinkingLevel(model: Model<Api>) {
  const levels = getSupportedThinkingLevels(model).filter((level) => level !== "off");
  if (levels.includes("minimal")) return "minimal";
  if (levels.includes("low")) return "low";
  return levels[0];
}

function restoreSavedTopic(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === TITLE_ENTRY_TYPE) {
      const data = entry.data as { topic?: unknown } | undefined;
      if (typeof data?.topic === "string" && data.topic.trim()) {
        return data.topic.trim();
      }
    }
  }
  return undefined;
}

function collectRecentTurns(ctx: ExtensionContext, maxTurns = 4): string[] {
  const branch = ctx.sessionManager.getBranch();
  const lines: string[] = [];
  for (let i = branch.length - 1; i >= 0 && lines.length < maxTurns; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractMessageText(entry.message);
    if (!text) continue;
    lines.unshift(`${role === "user" ? "用户" : "助手"}: ${text.slice(0, 180)}`);
  }
  return lines;
}

export default function terminalAttentionExtension(pi: ExtensionAPI): void {
  const myTty = resolveCurrentTty();

  let lastStopReason: string | undefined;
  let lastAssistantSummary = "";
  let lastNotifiedAt = 0;

  let currentTopic: string | undefined;
  let titleAbort: AbortController | undefined;
  let titleGeneration = 0;

  let tabPhase: TabPhase = "idle";
  let attentionKind: AlertKind = "done";
  let loadingFrameIndex = 0;
  let loadingTimer: ReturnType<typeof setInterval> | undefined;
  let focusWatchTimer: ReturnType<typeof setInterval> | undefined;
  let focusChecking = false;
  let lastRenderedTitle: string | undefined;
  let activeCtx: ExtensionContext | undefined;

  let terminalFocused: boolean | undefined;
  let focusReportingEnabled = false;
  let focusUnsubscribe: (() => void) | undefined;

  const isInteractiveTui = (ctx: ExtensionContext): boolean =>
    ctx.hasUI && ctx.mode === "tui";

  const baseTabTitle = (ctx: ExtensionContext): string => {
    if (currentTopic) return `π · ${currentTopic}`;
    const dirName = path.basename(ctx.cwd) || "pi";
    return `π · ${dirName}`;
  };

  const renderTabTitle = (ctx: ExtensionContext): void => {
    if (!isInteractiveTui(ctx)) return;
    const base = baseTabTitle(ctx);
    let nextTitle = base;
    if (tabPhase === "working") {
      nextTitle = `${LOADING_FRAMES[loadingFrameIndex]} ${base}`;
    } else if (tabPhase === "attention") {
      const badge = attentionKind === "blocked" ? "🔸" : attentionKind === "error" ? "🔻" : "🔹";
      nextTitle = `${badge} ${base}`;
    }
    if (nextTitle === lastRenderedTitle) return;
    lastRenderedTitle = nextTitle;
    ctx.ui.setTitle(nextTitle);
  };

  const stopLoadingTimer = (): void => {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = undefined;
    }
  };

  const stopFocusWatchTimer = (): void => {
    if (focusWatchTimer) {
      clearInterval(focusWatchTimer);
      focusWatchTimer = undefined;
    }
    focusChecking = false;
  };

  const clearTabStateToIdle = (ctx?: ExtensionContext): void => {
    stopLoadingTimer();
    stopFocusWatchTimer();
    tabPhase = "idle";
    if (ctx) {
      activeCtx = ctx;
      renderTabTitle(ctx);
    }
  };

  const enableFocusTracking = (ctx: ExtensionContext): void => {
    if (!isInteractiveTui(ctx)) return;
    activeCtx = ctx;
    if (!focusUnsubscribe) {
      focusUnsubscribe = ctx.ui.onTerminalInput((data) => {
        if (data === "\x1b[I") {
          terminalFocused = true;
          if (tabPhase === "attention") {
            clearTabStateToIdle(activeCtx);
          }
          return { consume: true };
        }
        if (data === "\x1b[O") {
          terminalFocused = false;
          return { consume: true };
        }
        return undefined;
      });
    }
    if (!focusReportingEnabled && process.stdout.isTTY) {
      try {
        process.stdout.write(FOCUS_ENABLE_SEQ);
        focusReportingEnabled = true;
      } catch {
        // Ignore stdout write errors.
      }
    }
  };

  const disableFocusTracking = (): void => {
    if (focusUnsubscribe) {
      focusUnsubscribe();
      focusUnsubscribe = undefined;
    }
    if (focusReportingEnabled && process.stdout.isTTY) {
      try {
        process.stdout.write(FOCUS_DISABLE_SEQ);
      } catch {
        // Ignore stdout write errors.
      }
      focusReportingEnabled = false;
    }
    terminalFocused = undefined;
  };

  const resolveVisibility = async (): Promise<TerminalVisibility> => {
    if (process.platform === "darwin" && myTty) {
      const macVis = await queryMacGhosttyVisibility(myTty);
      if (macVis === "FOCUSED" || macVis === "BACKGROUND") {
        return macVis;
      }
    }

    if (terminalFocused === false) return "BACKGROUND";
    if (terminalFocused === true) return "FOCUSED";

    if (process.platform === "win32") {
      return queryWindowsForegroundFallback();
    }

    return "FOCUSED";
  };

  const startWorkingAnimation = (ctx: ExtensionContext): void => {
    if (!isInteractiveTui(ctx)) return;
    activeCtx = ctx;
    stopFocusWatchTimer();
    stopLoadingTimer();
    tabPhase = "working";
    loadingFrameIndex = 0;
    renderTabTitle(ctx);
    loadingTimer = setInterval(() => {
      if (tabPhase !== "working" || !activeCtx) {
        stopLoadingTimer();
        return;
      }
      loadingFrameIndex = (loadingFrameIndex + 1) % LOADING_FRAMES.length;
      renderTabTitle(activeCtx);
    }, LOADING_INTERVAL_MS);
    loadingTimer.unref?.();
  };

  const startAttentionState = (ctx: ExtensionContext, kind: AlertKind): void => {
    if (!isInteractiveTui(ctx)) return;
    activeCtx = ctx;
    stopLoadingTimer();
    tabPhase = "attention";
    attentionKind = kind;
    renderTabTitle(ctx);

    if (process.platform !== "darwin" || !myTty || focusWatchTimer) return;
    focusWatchTimer = setInterval(() => {
      if (tabPhase !== "attention") {
        stopFocusWatchTimer();
        return;
      }
      if (focusChecking) return;
      focusChecking = true;
      void queryMacGhosttyVisibility(myTty)
        .then((vis) => {
          if (vis === "FOCUSED" && tabPhase === "attention") {
            clearTabStateToIdle(activeCtx);
          }
        })
        .finally(() => {
          focusChecking = false;
        });
    }, FOCUS_WATCH_INTERVAL_MS);
    focusWatchTimer.unref?.();
  };

  const applyTopic = (ctx: ExtensionContext, topic: string, persist = true): void => {
    const clean = normalizeTopic(topic);
    if (!clean || clean === currentTopic) return;
    currentTopic = clean;
    renderTabTitle(ctx);
    if (persist) {
      pi.appendEntry(TITLE_ENTRY_TYPE, { topic: clean });
    }
  };

  const abortPendingTitle = (): void => {
    titleGeneration++;
    titleAbort?.abort();
    titleAbort = undefined;
  };

  const requestTitleOnce = async (ctx: ExtensionContext, promptBody: string): Promise<void> => {
    if (!isInteractiveTui(ctx) || currentTopic) return;
    const model = findTerraModel(ctx);
    if (!model) return;

    abortPendingTitle();
    const version = titleGeneration;
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    titleAbort = controller;

    const systemPrompt = [
      "你是终端标签页标题生成器。",
      "根据用户的任务内容，提炼一个超简短的任务标题。",
      "硬性要求：4到10个汉字（或2到4个英文词），不要标点、不要引号、不要解释、不要加 π 前缀。",
    ].join("\n");

    const messages: Message[] = [
      {
        role: "user",
        content: promptBody,
        timestamp: Date.now(),
      },
    ];

    try {
      const options: Parameters<typeof ctx.modelRegistry.streamSimple>[2] = {
        signal: controller.signal,
        sessionId: `${sessionId}:tab-title`,
        maxRetries: 0,
        transport: "auto",
      };
      if (model.reasoning) {
        const level = pickLowestThinkingLevel(model);
        if (level) {
          options.reasoning = level;
        }
      }
      const response = await ctx.modelRegistry.streamSimple(model, { systemPrompt, messages }, options).result();
      if (version !== titleGeneration || controller.signal.aborted) return;
      if (ctx.sessionManager.getSessionId() !== sessionId) return;
      if (response.stopReason === "error" || response.stopReason === "aborted") return;

      const text = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();

      if (!text) return;
      applyTopic(ctx, text, true);
    } catch {
      // Ignore silent title errors so the foreground chat is never interrupted.
    } finally {
      if (titleAbort === controller) {
        titleAbort = undefined;
      }
    }
  };

  const syncTopicOnSessionChange = (ctx: ExtensionContext): void => {
    abortPendingTitle();
    currentTopic = undefined;
    lastRenderedTitle = undefined;
    clearTabStateToIdle(ctx);
    if (!isInteractiveTui(ctx)) return;

    const saved = restoreSavedTopic(ctx);
    if (saved) {
      applyTopic(ctx, saved, false);
      return;
    }

    const recent = collectRecentTurns(ctx, 4);
    if (recent.length > 0) {
      void requestTitleOnce(ctx, `会话摘要：\n${recent.join("\n")}`);
    }
  };

  const notifyIfBackground = async (ctx: ExtensionContext, kind: AlertKind, promptTitle?: string) => {
    if (!isInteractiveTui(ctx)) return;
    const now = Date.now();
    if (now - lastNotifiedAt < 1200) return;

    const vis = await resolveVisibility();
    if (vis !== "BACKGROUND") {
      clearTabStateToIdle(ctx);
      return;
    }

    lastNotifiedAt = Date.now();
    startAttentionState(ctx, kind);
    playSound(kind === "error" ? SOUND_ERROR : SOUND_DONE);

    const notifyTitle = baseTabTitle(ctx);
    let notifyBody = "已完成当前轮次";
    if (kind === "blocked") {
      notifyBody = promptTitle ? `需要确认：${promptTitle}` : "需要你确认或输入";
    } else if (kind === "error") {
      notifyBody = "执行出错，请查看";
    } else if (lastAssistantSummary) {
      notifyBody = lastAssistantSummary;
    }
    sendDesktopNotification(notifyTitle, notifyBody);
  };

  pi.on("session_start", (_event, ctx) => {
    enableFocusTracking(ctx);
    syncTopicOnSessionChange(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    syncTopicOnSessionChange(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    abortPendingTitle();
    clearTabStateToIdle(ctx);
    disableFocusTracking();
  });

  pi.on("input", (event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    if (tabPhase === "attention") {
      clearTabStateToIdle(ctx);
    }
    if (event.source !== "interactive" || currentTopic) return;
    const raw = event.text.trim();
    if (!raw || raw.startsWith("/")) return;

    if (raw.length >= 3 && !CONTINUATION_RE.test(raw)) {
      void requestTitleOnce(ctx, `项目目录: ${path.basename(ctx.cwd)}\n用户消息: ${raw.slice(0, 400)}`);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    lastStopReason = undefined;
    lastAssistantSummary = "";
    startWorkingAnimation(ctx);
  });

  pi.on("message_end", (event) => {
    const msg = event.message as { role?: string; stopReason?: string } | undefined;
    if (msg?.role === "assistant") {
      if (typeof msg.stopReason === "string") {
        lastStopReason = msg.stopReason;
      }
      const text = extractMessageText(msg);
      if (text) {
        lastAssistantSummary = sanitizeOscField(text.replace(/[#*`>_~]/g, ""), 72);
      }
    }
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    stopLoadingTimer();
    await notifyIfBackground(ctx, "blocked", event.title);
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    if (!ctx.isIdle()) {
      startWorkingAnimation(ctx);
    } else if (tabPhase === "attention") {
      clearTabStateToIdle(ctx);
    }
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (!isInteractiveTui(ctx)) return;

    if (!currentTopic && !event.aborted) {
      const recent = collectRecentTurns(ctx, 4);
      if (recent.length > 0) {
        void requestTitleOnce(ctx, `项目目录: ${path.basename(ctx.cwd)}\n对话片段:\n${recent.join("\n")}`);
      }
    }

    if (event.aborted) {
      clearTabStateToIdle(ctx);
      return;
    }
    const kind: AlertKind = lastStopReason === "error" ? "error" : "done";
    await notifyIfBackground(ctx, kind);
  });
}
