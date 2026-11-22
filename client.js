/**
 * dsh-screenshot-bridge — Client half.
 *
 * One surface:
 *   - a Settings page (`settings.section`) that edits the bridge switch, the
 *     system-wide hotkey and the target conversation id. The form supplies
 *     initial values only; saves go through the Host route into the plugin's
 *     own `settings.json`, so a bundle-only install stays editable.
 *
 * Delivery long-polls the Host for the next capture, uploads that PNG into the
 * target conversation and sends it. The composer/dialog area stays untouched.
 *
 * @module dsh-screenshot-bridge/client
 */
window.__ModuleLoader__.load({
  id: "dsh-screenshot-bridge",
  factory: (require) => {
    var React = require("react");

    var ROUTE = "/api/screenshot-bridge";
    var NS = "screenshotBridge";
    var ENTRY = "screenshot-bridge";
    var TARGET_KEY = "dsh.screenshot-bridge.target";
    var HOTKEY_KEY = "dsh.screenshot-bridge.hotkey";

    var DICT = {
      zh: {
        label: "截图",
        idle: "按 {hotkey} 发送全屏截图",
        noTarget: "本对话",
        pinned: "会话 {id}",
        pin: "绑定",
        unpin: "解除",
        record: "改键",
        recording: "按下新组合…（Esc 取消）",
        sent: "已发送 {time}",
        hotkeyChanged: "快捷键 {hotkey}",
        failed: "发送失败：{message}",
        unreachable: "截图桥不可用",
        noTargetHint: "截图已生成，但还没有目标对话",
        title: "截图桥",
        intro: "按全局快捷键截取全屏，并把截图作为一条消息发到指定会话。",
        enabled: "启用截图桥",
        enabledHint: "关闭后不再注册全局快捷键，也不会投递截图。",
        on: "已启用",
        off: "已停用",
        hotkeyLabel: "快捷键",
        hotkeyHint: "点「录制」后按组合键、鼠标侧键或滚轮，也可直接输入。键盘组合至少一个修饰键，例如 Alt+Z；鼠标可写 Alt+XButton1、Ctrl+WheelUp。",
        sessionLabel: "会话 ID",
        sessionHint: "截图固定发往该会话；请填写会话 ID，留空不会投递。",
        sessionPlaceholder: "session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        save: "保存",
        saved: "已保存",
        saving: "保存中…",
        saveFailed: "保存失败，请稍后重试",
        invalidSession: "会话 ID 格式不对，应以 session- 开头",
        invalidHotkey: "快捷键格式不对：键盘组合至少需要一个修饰键；鼠标支持 XButton1/XButton2/WheelUp/WheelDown",
        unavailable: "设置服务尚未就绪",
        statusLabel: "运行状态",
        running: "热键已注册，运行中",
        stopped: "热键未注册",
        disabledState: "已关闭",
        errorState: "错误：{message}",
        allScreensLabel: "截取全部屏幕",
        allScreensHint: "默认只截鼠标所在的那块屏幕。",
        modeLabel: "截图怎么给模型",
        modeHint: "两个方案随时切换：直接发截图，或发「原截图 + 本地识别出的文字」。文字只当辅助，出错以截图为准；认不出文字就只发截图。",
        modeImage: "直接发截图",
        modeExtract: "原截图 + 文字",
        modeImageNote: "已切换：直接发截图",
        modeExtractNote: "已切换：原截图 + 文字",
        modeFailed: "切换没写进去：当前运行的可能还是旧版 Host，重启 DSH 后再点一次",
        promptLabel: "附带文字",
        promptHint: "随截图一起发送；可用 {time} 插入本地时间。改完点「保存」生效。",
        promptPlaceholder: "输入随截图发送的文字，例如：按截图里的题目顺序给出答案",
      },
      en: {
        label: "Shot",
        idle: "Press {hotkey} to send a screenshot",
        noTarget: "this chat",
        pinned: "conversation {id}",
        pin: "pin",
        unpin: "clear",
        record: "key",
        recording: "press a combination… (Esc cancels)",
        sent: "sent {time}",
        hotkeyChanged: "shortcut {hotkey}",
        failed: "failed: {message}",
        unreachable: "bridge unavailable",
        noTargetHint: "captured, but no target conversation",
        title: "Screenshot bridge",
        intro: "A global hotkey captures the screen and sends it as one message to a chosen conversation.",
        enabled: "Enable the bridge",
        enabledHint: "When off, the global hotkey is unregistered and captures are not sent.",
        on: "enabled",
        off: "disabled",
        hotkeyLabel: "Hotkey",
        hotkeyHint: "Press Record and press a chord, mouse side button, or wheel; typing works too. Keyboard chords need one modifier, e.g. Alt+Z; mouse examples: Alt+XButton1, Ctrl+WheelUp.",
        sessionLabel: "Conversation id",
        sessionHint: "Captures always go to this conversation; fill in the id, blank never sends.",
        sessionPlaceholder: "session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        save: "Save",
        saved: "Saved",
        saving: "Saving…",
        saveFailed: "Save failed; try again",
        invalidSession: "That is not a conversation id; it should start with session-",
        invalidHotkey: "A hotkey needs at least one modifier and one key",
        unavailable: "The settings service is not ready",
        statusLabel: "Status",
        running: "hotkey registered, running",
        stopped: "hotkey not registered",
        disabledState: "off",
        errorState: "error: {message}",
        allScreensLabel: "Capture every display",
        allScreensHint: "Off captures only the display under the pointer.",
        modeLabel: "What the model receives",
        modeHint: "Switch any time: the screenshot alone, or the screenshot plus text recognised locally. The text is a helper only — the picture wins; if nothing is recognised, the picture goes alone.",
        modeImage: "Send the screenshot",
        modeExtract: "Extract first",
        modeImageNote: "Switched: send the screenshot",
        modeExtractNote: "Switched: screenshot + text",
        modeFailed: "The switch did not stick: the running Host may still be the old build — restart DSH and try again",
        promptLabel: "Message text",
        promptHint: "Sent with the capture; {time} inserts the local clock. Save to apply.",
        promptPlaceholder: "Text to send with the screenshot, e.g. answer the questions in order",
      },
    };

    var translate = null;
    function tr(key, params) {
      var fallback = translate !== null ? translate(key, params) : null;
      if (fallback !== null && fallback !== undefined) return fallback;
      var text = DICT.zh[key] ?? key;
      return params === undefined ? text : text.replace(/\{(\w+)\}/gu, (_, name) => String(params[name]));
    }

    /** Shared settings form, created once in `apply`. */
    var form = null;
    /** Sync state of that form. */
    var formStatus = "loading";
    /** Whether the Host document accepts writes for this row. */
    var formWritable = false;
    /** Last accepted settings; mirrors the Host's live config. */
    var DEFAULT_PROMPT = "我给的截图里面有一些题，你根据截图里的题目按顺序给出答案。只给干净的答案，不要给思考过程";
    var settings = { enabled: true, hotkey: "Alt+Z", sessionId: "", allScreens: false, prompt: DEFAULT_PROMPT, mode: "extract", extract: true };
    /** Whether the Host route has supplied the authoritative settings file. */
    var hostSettingsLoaded = false;
    /** Latest Host facts for the status lines. */
    var hostState = { running: false, error: null, latestSeq: 0 };
    /** One shared status line, so any mounted surface can show the newest outcome. */
    var status = { text: "", level: "info", seq: 0 };
    var listeners = new Set();

    function notify() {
      for (var listener of [...listeners]) {
        try {
          listener();
        } catch {
          // a broken listener must not break delivery
        }
      }
    }

    function publish(text, level) {
      status = { text: text, level: level === undefined ? "info" : level, seq: status.seq + 1 };
      notify();
    }

    function readStored(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    }

    function writeStored(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch {
        // private mode or blocked storage: settings live on the Host anyway
      }
    }

    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /** Best-effort telemetry into the Host log; never throws, never blocks. */
    function report(text) {
      try {
        void fetch(ROUTE + "?op=diag&data=" + encodeURIComponent(text), { cache: "no-store" }).catch(function () {});
      } catch {
        // the Host is not reachable yet; the poll loop retries anyway
      }
    }

    function pad(value) {
      return value < 10 ? "0" + value : String(value);
    }

    function clock() {
      var now = new Date();
      return pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
    }

    function stamp() {
      var now = new Date();
      return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
        + "-" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    }

    function messageOf(error) {
      if (error === null || error === undefined) return "unknown error";
      if (typeof error === "string") return error;
      if (typeof error.message === "string" && error.message !== "") return error.message;
      return String(error);
    }

    /** Accepts `session-<uuid>` and a bare uuid; rejects anything else. */
    function validSessionId(value) {
      return /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
    }

    /** Canonical mouse action name, or null when the token is not a mouse trigger. */
    function mouseActionOf(token) {
      switch (String(token).trim().toLowerCase()) {
        case "xbutton1": case "mouse4": case "back": return "XButton1";
        case "xbutton2": case "mouse5": case "forward": return "XButton2";
        case "middle": case "middlebutton": case "mouse3": return "MiddleButton";
        case "wheelup": case "scrollup": return "WheelUp";
        case "wheeldown": case "scrolldown": return "WheelDown";
        case "wheelleft": case "scrollleft": return "WheelLeft";
        case "wheelright": case "scrollright": return "WheelRight";
        default: return null;
      }
    }

    var MODIFIER_ORDER = ["ctrl", "alt", "shift", "win"];

    /**
     * Canonical chord: ordered modifiers plus a keyboard key or mouse action.
     * Keyboard chords need at least one modifier; mouse triggers may stand alone.
     * Any number of modifiers is accepted, so Ctrl+Alt+Shift+F10 records fully.
     */
    function normalizeHotkey(value) {
      var parts = String(value).split("+").map(function (part) { return part.trim(); }).filter(Boolean);
      if (parts.length < 1) return null;
      var last = parts[parts.length - 1];
      var mouse = mouseActionOf(last);
      var modifiers = [];
      for (var i = 0; i < parts.length - 1; i += 1) {
        var modifier = parts[i].toLowerCase();
        if (modifier === "control") modifier = "ctrl";
        if (modifier === "meta") modifier = "win";
        if (MODIFIER_ORDER.indexOf(modifier) < 0) return null;
        if (modifiers.indexOf(modifier) < 0) modifiers.push(modifier);
      }
      if (mouse === null && modifiers.length === 0) return null;
      modifiers.sort(function (a, b) { return MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b); });
      var displayModifiers = modifiers.map(function (modifier) {
        if (modifier === "ctrl") return "Ctrl";
        if (modifier === "alt") return "Alt";
        if (modifier === "shift") return "Shift";
        return "Win";
      });
      var key = mouse;
      if (key === null) {
        var code = last.toUpperCase();
        if (/^[A-Z0-9]$/u.test(code)) key = code;
        else if (/^F\d{1,2}$/u.test(code)) {
          var number = Number(code.slice(1));
          if (number < 1 || number > 24) return null;
          key = code;
        } else {
          var names = {
            PRINTSCREEN: "PrintScreen", PRTSC: "PrintScreen", SCROLLLOCK: "ScrollLock", PAUSE: "Pause",
            INSERT: "Insert", DELETE: "Delete", DEL: "Delete", HOME: "Home", END: "End",
            PAGEUP: "PageUp", PAGEDOWN: "PageDown", LEFT: "Left", UP: "Up", RIGHT: "Right", DOWN: "Down",
            SPACE: "Space", TAB: "Tab", ENTER: "Enter", RETURN: "Enter", BACKSPACE: "Backspace",
            ESC: "Esc", ESCAPE: "Esc", BACKQUOTE: "`", MINUS: "-", EQUAL: "=",
          };
          key = names[code] ?? (/^[-=\[\]';.,\/\\`]$/u.test(last) ? last : null);
          if (key === null) return null;
        }
      }
      return displayModifiers.concat([key]).join("+");
    }

    function validHotkey(value) {
      return normalizeHotkey(value) !== null;
    }

    /** Persist one field through the Host route, so bundle-only installs work too. */
    async function writeField(field, value) {
      for (var attempt = 0; attempt < 2; attempt += 1) {
        try {
          var response = await fetch(ROUTE + "?op=save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [field]: value }),
          });
          if (!response.ok) {
            await sleep(350);
            continue;
          }
          var data = await response.json().catch(function () { return null; });
          if (data !== null && typeof data === "object" && data.settings !== undefined) {
            settings = normalizeSettings(data.settings);
            hostSettingsLoaded = true;
            notify();
          }
          return true;
        } catch {
          await sleep(350);
        }
      }
      return false;
    }

    /** 输入框失焦不再自动提交：只有回车或「保存」按钮才写，免得点别的开关时被顺手写进去。 */
    function normalizeSettings(value) {
      var raw = value !== null && typeof value === "object" ? value : {};
      return {
        enabled: raw.enabled === undefined ? true : raw.enabled !== false,
        hotkey: typeof raw.hotkey === "string" && raw.hotkey !== "" ? raw.hotkey : "Alt+Z",
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId.trim() : "",
        allScreens: raw.allScreens === true,
        prompt: typeof raw.prompt === "string" ? raw.prompt : DEFAULT_PROMPT,
        // `mode` is the switch the card edits; `extract` stays as the legacy alias
        // older settings files (and the Host) still carry.
        mode: raw.mode === "image" || raw.mode === "extract"
          ? raw.mode
          : (raw.extract === false ? "image" : "extract"),
        extract: (raw.mode === "image" || raw.mode === "extract" ? raw.mode : (raw.extract === false ? "image" : "extract")) === "extract",
      };
    }

    /** Pull the newest values out of the shared form and wake every surface. */
    function syncFromForm() {
      if (form === null) return;
      var snapshot = form.getSnapshot();
      formStatus = snapshot.status;
      formWritable = snapshot.writable === true;
      if (!hostSettingsLoaded && snapshot.status === "ready" && snapshot.value !== undefined) {
        settings = normalizeSettings(snapshot.value);
      }
      notify();
    }

    /** Seed the Host from values this plugin used to keep in localStorage. */
    async function migrateStored() {
      var storedHotkey = readStored(HOTKEY_KEY);
      if (storedHotkey !== null && storedHotkey !== "" && storedHotkey !== settings.hotkey && validHotkey(storedHotkey)) {
        if (await writeField("hotkey", normalizeHotkey(storedHotkey))) writeStored(HOTKEY_KEY, null);
      }
      var storedTarget = readStored(TARGET_KEY);
      if (storedTarget !== null && storedTarget !== "" && settings.sessionId === "" && validSessionId(storedTarget)) {
        if (await writeField("sessionId", storedTarget)) writeStored(TARGET_KEY, null);
      }
    }

    /** Read the Host's running state; used by both surfaces' status lines. */
    async function fetchState() {
      try {
        var response = await fetch(ROUTE + "?op=state", { cache: "no-store" });
        if (!response.ok) return null;
        var data = await response.json();
        if (data === null || typeof data !== "object") return null;
        if (data.settings !== undefined) settings = normalizeSettings(data.settings);
        if (data.settings !== undefined) hostSettingsLoaded = true;
        hostState = {
          running: data.running === true,
          error: typeof data.error === "string" ? data.error : null,
          latestSeq: typeof data.latestSeq === "number" ? data.latestSeq : 0,
        };
        notify();
        if (hostState.error !== null && hostState.error !== "") report("host-error " + hostState.error);
        return hostState;
      } catch {
        return null;
      }
    }

    /** Prompt text sent with the image; `{time}` becomes the local clock. */
    function promptText() {
      var template = typeof settings.prompt === "string" ? settings.prompt : "";
      if (template === "") return "";
      return template.replace(/\{time\}/gu, clock());
    }

    /** Wait until every staged draft finished uploading, or explain why it cannot. */
    function waitForUploads(ctx, ids) {
      return new Promise(function (resolve, reject) {
        var started = Date.now();
        function check() {
          var uploads;
          try {
            uploads = ctx.conversation.fileUploads.getSnapshot();
          } catch (error) {
            reject(error);
            return;
          }
          var pending = 0;
          for (var index = 0; index < ids.length; index += 1) {
            var upload = uploads[ids[index]];
            if (upload === undefined || upload.status === "uploading") {
              pending += 1;
              continue;
            }
            if (upload.status === "error") {
              reject(new Error(upload.reason || upload.message || "upload rejected"));
              return;
            }
          }
          if (pending === 0) {
            resolve();
            return;
          }
          if (Date.now() - started > 30000) {
            reject(new Error("upload timed out"));
            return;
          }
          setTimeout(check, 150);
        }
        check();
      });
    }

    /**
     * Ask the Host to turn one capture into question text. Any failure here is
     * a normal outcome: the caller falls back to sending the PNG itself.
     */
    async function extractQuestions(capture) {
      try {
        var response = await fetch(ROUTE + "?op=extract&id=" + encodeURIComponent(capture.id));
        if (!response.ok) {
          report("extract http " + String(response.status));
          return null;
        }
        var payload = await response.json();
        if (payload === null || payload.ok !== true || typeof payload.text !== "string" || payload.text.trim() === "") {
          report("extract skipped: " + String(payload !== null && payload.reason ? payload.reason : "empty"));
          return null;
        }
        return payload;
      } catch (error) {
        report("extract failed: " + messageOf(error));
        return null;
      }
    }

    /** Fetch the original screenshot as a draft-ready file; null when unavailable. */
    async function fetchShot(capture) {
      try {
        var response = await fetch(ROUTE + "?op=image&id=" + encodeURIComponent(capture.id));
        if (!response.ok) {
          report("image " + String(response.status));
          return null;
        }
        var blob = await response.blob();
        if (blob.size === 0) return null;
        return new window.File([blob], "screenshot-" + stamp() + ".png", { type: "image/png" });
      } catch (error) {
        report("image failed: " + messageOf(error));
        return null;
      }
    }

    /** Pull the figures the extractor cropped, as draft-ready files. */
    async function extractFigures(capture, figures) {
      var list = Array.isArray(figures) ? figures : [];
      var files = [];
      for (var index = 0; index < list.length && files.length < 8; index += 1) {
        var n = list[index].n;
        if (typeof n !== "number") continue;
        try {
          var response = await fetch(ROUTE + "?op=figure&id=" + encodeURIComponent(capture.id) + "&n=" + String(n));
          if (!response.ok) {
            report("figure " + String(n) + " http " + String(response.status));
            continue;
          }
          var blob = await response.blob();
          if (blob.size === 0) continue;
          files.push(new window.File([blob], "图" + String(n) + ".png", { type: "image/png" }));
        } catch (error) {
          report("figure " + String(n) + " failed: " + messageOf(error));
        }
      }
      return files;
    }

    /** Fetch one capture, stage it as an image draft, and send it to the target. */
    async function deliver(ctx, capture) {
      var target = settings.sessionId;
      if (target === "") {
        publish(tr("noTargetHint"), "error");
        return;
      }

      // "extract" 模式：**原截图一定要发**，本地认出来的文字只当辅助一起附上。
      // 认不出来（空文本）就退化成只发图，不会让截图发不出去。
      if (settings.mode === "extract") {
        var extracted = await extractQuestions(capture);
        var shotFile = await fetchShot(capture);
        if (shotFile !== null) {
          var composed = promptText();
          var text = extracted !== null && typeof extracted.text === "string" ? extracted.text.trim() : "";
          if (text !== "") {
            composed += "\n\n下面是从截图里认出来的文字（可能有错字、漏行、顺序错乱，仅供你参考和复制；"
              + "内容以附上的原截图为准）：\n" + text;
            var notes = Array.isArray(extracted.warnings) ? extracted.warnings : [];
            if (notes.length > 0) {
              composed += "\n\n本地校验没对上的地方（以截图为准，必要时回头看一眼整页）：\n- "
                + notes.slice(0, 6).join("\n- ");
            }
          }
          var drafts = null;
          try {
            var ids = [];
            drafts = ctx.conversation.createDrafts(target, [shotFile], true);
            ids = drafts.map(function (draft) { return draft.id; });
            await waitForUploads(ctx, ids);
            var textOutcome = await ctx.sessions.using(target, { source: "screenshotBridge" }, async function (reference) {
              return await ctx.conversation.sendSession(reference.binding.session, composed, ids, "queue");
            });
            if (textOutcome !== undefined && textOutcome !== null && textOutcome.kind === "error") {
              throw new Error(textOutcome.text || "conversation rejected the message");
            }
            publish(tr("sent", { time: clock() }), "info");
            return;
          } catch (error) {
            if (drafts !== null) {
              try {
                ctx.conversation.releaseDraftAttachments(drafts);
              } catch {
                // already released by the accepted submission
              }
            }
            report("text+shot send failed, falling back to plain image: " + messageOf(error));
          }
        } else if (extracted !== null) {
          report("screenshot unavailable, sending text only");
        }
      }

      var response = await fetch(ROUTE + "?op=image&id=" + encodeURIComponent(capture.id));
      if (!response.ok) throw new Error("image " + String(response.status));
      var blob = await response.blob();
      var file = new window.File([blob], "screenshot-" + stamp() + ".png", { type: "image/png" });

      var drafts = ctx.conversation.createDrafts(target, [file], true);
      var ids = drafts.map(function (draft) { return draft.id; });
      try {
        await waitForUploads(ctx, ids);
        var outcome = await ctx.sessions.using(target, { source: "screenshotBridge" }, async function (reference) {
          return await ctx.conversation.sendSession(reference.binding.session, promptText(), ids, "queue");
        });
        if (outcome !== undefined && outcome !== null && outcome.kind === "error") {
          throw new Error(outcome.text || "conversation rejected the message");
        }
        publish(tr("sent", { time: clock() }), "info");
      } catch (error) {
        try {
          ctx.conversation.releaseDraftAttachments(drafts);
        } catch {
          // already released by the accepted submission
        }
        throw error;
      }
    }

    /**
     * Long-poll the Host for captures. The first read starts the subscription
     * from the Host's newest sequence, so reopening the app never replays a
     * backlog into a conversation.
     */
    function startPolling(ctx) {
      var alive = true;
      var controller = new AbortController();
      var since = 0;

      void (async function () {
        var initial = await fetchState();
        if (initial === null) {
          report("client-poll unreachable");
          publish(tr("unreachable"), "error");
        } else {
          report("client-poll ready running=" + String(initial.running));
          since = typeof initial.latestSeq === "number" ? initial.latestSeq : 0;
        }

        while (alive) {
          try {
            var response = await fetch(ROUTE + "?op=wait&since=" + String(since), {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!alive) return;
            if (!response.ok) {
              await sleep(1500);
              continue;
            }
            var data = await response.json();
            if (data !== null && typeof data === "object") {
              var latest = typeof data.latestSeq === "number" ? data.latestSeq : since;
              if (latest > since) since = latest;
              var captures = Array.isArray(data.captures) ? data.captures : [];
              for (var index = 0; index < captures.length; index += 1) {
                if (!alive) return;
                if (!settings.enabled) continue;
                try {
                  await deliver(ctx, captures[index]);
                } catch (error) {
                  publish(tr("failed", { message: messageOf(error) }), "error");
                  report("deliver: " + messageOf(error));
                }
              }
            }
          } catch (error) {
            if (!alive) return;
            await sleep(1200);
          }
        }
      })();

      return function () {
        alive = false;
        controller.abort();
      };
    }

    /* ------------------------------------------------------------------ keys */

    /** Translate one physical key to the spelling the Host helper understands. */
    function keyNameOf(event) {
      var code = typeof event.code === "string" ? event.code : "";
      if (/^Key[A-Z]$/u.test(code)) return code.slice(3);
      if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
      if (/^F\d{1,2}$/u.test(code)) return code;
      var names = {
        Space: "Space", Escape: "Esc", Tab: "Tab", Enter: "Enter", Backspace: "Backspace",
        PrintScreen: "PrintScreen", Insert: "Insert", Delete: "Delete", Home: "Home", End: "End",
        PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down",
        ArrowLeft: "Left", ArrowRight: "Right", Backquote: "`", Minus: "-", Equal: "=",
        BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",",
        Period: ".", Slash: "/", Backslash: "\\",
      };
      return names[code] ?? null;
    }

    /** Spell a chord in the same order the Host normalizes to. */
    function comboOf(event) {
      var modifiers = [];
      if (event.ctrlKey === true) modifiers.push("Ctrl");
      if (event.altKey === true) modifiers.push("Alt");
      if (event.shiftKey === true) modifiers.push("Shift");
      if (event.metaKey === true) modifiers.push("Win");
      var key = keyNameOf(event);
      if (key === null || modifiers.length === 0) return null;
      return normalizeHotkey(modifiers.concat([key]).join("+"));
    }

    /** Spell a mouse chord exactly like the Host/helper expects. */
    function comboOfMouse(event, action) {
      var modifiers = [];
      if (event.ctrlKey === true) modifiers.push("Ctrl");
      if (event.altKey === true) modifiers.push("Alt");
      if (event.shiftKey === true) modifiers.push("Shift");
      if (event.metaKey === true) modifiers.push("Win");
      return normalizeHotkey(modifiers.concat([action]).join("+"));
    }

    /* --------------------------------------------------------------- surfaces */

    var INPUT_STYLE = {
      height: "30px",
      padding: "0 10px",
      border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "var(--dsw-radius-md)",
      background: "var(--dsw-alias-bg-layer-3)",
      font: "inherit",
      fontSize: "13px",
      lineHeight: "1.5",
      color: "var(--dsw-alias-label-primary)",
      minWidth: "0",
    };

    var SMALL_BUTTON_STYLE = {
      height: "30px",
      padding: "0 12px",
      border: "0.5px solid var(--dsw-alias-border-l4)",
      borderRadius: "var(--dsw-radius-md)",
      background: "var(--dsw-alias-bg-layer-3)",
      font: "inherit",
      fontSize: "13px",
      color: "var(--dsw-alias-label-primary)",
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

    function useModuleState() {
      var stateSet = React.useState(0);
      var setState = stateSet[1];
      React.useEffect(function () {
        var listener = function () { setState(function (value) { return value + 1; }); };
        listeners.add(listener);
        return function () { listeners.delete(listener); };
      }, [setState]);
      return stateSet[0];
    }

    /** The Settings page: switch, hotkey recorder, target conversation id. */
    function SettingsCard(props) {
      useModuleState();
      var t = typeof props.t === "function" ? props.t : tr;
      var locked = false;

      var draftHotkey = React.useState(settings.hotkey);
      var hotkey = draftHotkey[0];
      var setHotkey = draftHotkey[1];

      var draftSession = React.useState(settings.sessionId);
      var session = draftSession[0];
      var setSession = draftSession[1];

      var draftPrompt = React.useState(settings.prompt);
      var prompt = draftPrompt[0];
      var setPrompt = draftPrompt[1];

      var recordingState = React.useState(false);
      var recording = recordingState[0];
      var setRecording = recordingState[1];

      var noteState = React.useState(null);
      var note = noteState[0];
      var setNote = noteState[1];

      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      // Follow accepted values unless the user is mid-edit on that field.
      var dirtyHotkey = React.useRef(false);
      var dirtySession = React.useRef(false);
      var dirtyPrompt = React.useRef(false);
      React.useEffect(function () {
        if (dirtyHotkey.current && normalizeHotkey(hotkey) === settings.hotkey) dirtyHotkey.current = false;
        if (dirtySession.current && session.trim() === settings.sessionId) dirtySession.current = false;
        if (dirtyPrompt.current && prompt === settings.prompt) dirtyPrompt.current = false;
        if (!dirtyHotkey.current) setHotkey(settings.hotkey);
        if (!dirtySession.current) setSession(settings.sessionId);
        if (!dirtyPrompt.current) setPrompt(settings.prompt);
      }, [settings.hotkey, settings.sessionId, settings.prompt, setHotkey, setSession, setPrompt]);

      // Leaving the page (including pressing Back) must not strand a draft.
      var draftSnapshot = React.useRef(null);
      draftSnapshot.current = {
        hotkey: hotkey,
        session: session,
        prompt: prompt,
        dirtyHotkey: dirtyHotkey.current,
        dirtySession: dirtySession.current,
        dirtyPrompt: dirtyPrompt.current,
      };
      React.useEffect(function () {
        // 只保留一份草稿快照给"离开设置页"的收尾用；不在这里自动提交，
        // 免得点别的开关时把没按保存的会话/提示词一起写进去。
        return function () {
          draftSnapshot.current = null;
        };
      }, []);

      React.useEffect(function () {
        void fetchState();
        // The helper restarts asynchronously after a save; keep the status
        // line honest without asking every surface to poll.
        var timer = window.setInterval(function () { void fetchState(); }, 2500);
        return function () { window.clearInterval(timer); };
      }, []);

      // One event while armed; Esc cancels. Keyboard chords, mouse side
      // buttons, the middle button, and wheel notches are all recordable.
      React.useEffect(function () {
        if (!recording) return undefined;
        var finish = function (combo) {
          if (combo === null) return;
          setRecording(false);
          dirtyHotkey.current = true;
          setHotkey(combo);
          void commitHotkey(combo);
        };
        var onKeyDown = function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat === true) return;
          if (event.key === "Escape") {
            setRecording(false);
            return;
          }
          finish(comboOf(event));
        };
        var onMouseDown = function (event) {
          var action = event.button === 3 ? "XButton1" : event.button === 4 ? "XButton2" : event.button === 1 ? "MiddleButton" : null;
          if (action === null) return;
          event.preventDefault();
          event.stopPropagation();
          finish(comboOfMouse(event, action));
        };
        var onWheel = function (event) {
          event.preventDefault();
          event.stopPropagation();
          var action = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
            ? (event.deltaY < 0 ? "WheelUp" : event.deltaY > 0 ? "WheelDown" : null)
            : (event.deltaX > 0 ? "WheelRight" : event.deltaX < 0 ? "WheelLeft" : null);
          finish(comboOfMouse(event, action));
        };
        var onContextMenu = function (event) { event.preventDefault(); };
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("mousedown", onMouseDown, true);
        window.addEventListener("wheel", onWheel, { capture: true, passive: false });
        window.addEventListener("contextmenu", onContextMenu, true);
        return function () {
          window.removeEventListener("keydown", onKeyDown, true);
          window.removeEventListener("mousedown", onMouseDown, true);
          window.removeEventListener("wheel", onWheel, true);
          window.removeEventListener("contextmenu", onContextMenu, true);
        };
      }, [recording, setHotkey, setRecording]);

      async function commitHotkey(value) {
        var canonical = normalizeHotkey(value);
        if (canonical === null) {
          setNote({ level: "error", text: t("invalidHotkey") });
          return;
        }
        setBusy(true);
        try {
          var ok = await writeField("hotkey", canonical);
          if (!ok) {
            setNote({ level: "error", text: t("saveFailed") });
            return;
          }
          dirtyHotkey.current = false;
          setHotkey(canonical);
          setNote({ level: "ok", text: t("saved") });
          publish(t("hotkeyChanged", { hotkey: canonical }), "info");
          void fetchState();
        } catch (error) {
          setNote({ level: "error", text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      }

      async function toggle() {
        setBusy(true);
        try {
          var ok = await writeField("enabled", !settings.enabled);
          if (!ok) setNote({ level: "error", text: t("saveFailed") });
          else setNote({ level: "ok", text: t("saved") });
          void fetchState();
        } catch (error) {
          setNote({ level: "error", text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      }

      async function commitSession() {
        var trimmed = session.trim();
        if (trimmed !== "" && !validSessionId(trimmed)) {
          setNote({ level: "error", text: t("invalidSession") });
          return;
        }
        // A bare uuid is the same conversation; spell it the way sessions do.
        var target = /^[0-9a-f]{8}-/iu.test(trimmed) ? "session-" + trimmed : trimmed;
        setBusy(true);
        try {
          var ok = await writeField("sessionId", target);
          if (!ok) {
            setNote({ level: "error", text: t("saveFailed") });
            return;
          }
          dirtySession.current = false;
          setSession(target);
          setNote({ level: "ok", text: t("saved") });
        } catch (error) {
          setNote({ level: "error", text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      }

      /** Flip the delivery switch: image straight through, or extract first. */
      async function commitMode(value) {
        var before = settings.mode;
        // 先改本地状态，按钮立刻有反馈；写失败再翻回去。
        settings = { ...settings, mode: value, extract: value === "extract" };
        notify();
        setBusy(true);
        try {
          var ok = await writeField("mode", value);
          if (!ok) {
            settings = { ...settings, mode: before, extract: before === "extract" };
            notify();
            setNote({ level: "error", text: t("modeFailed") });
            return;
          }
          setNote({ level: "ok", text: value === "image" ? t("modeImageNote") : t("modeExtractNote") });
          void fetchState();
        } catch (error) {
          settings = { ...settings, mode: before, extract: before === "extract" };
          notify();
          setNote({ level: "error", text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      }

      async function commitPrompt() {
        setBusy(true);
        try {
          var ok = await writeField("prompt", prompt);
          if (!ok) {
            setNote({ level: "error", text: t("saveFailed") });
            return;
          }
          dirtyPrompt.current = false;
          setNote({ level: "ok", text: t("saved") });
        } catch (error) {
          setNote({ level: "error", text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      }

      var hostLine = !settings.enabled
        ? t("disabledState")
        : hostState.error !== null && hostState.error !== ""
          ? t("errorState", { message: hostState.error })
          : hostState.running ? t("running") : t("stopped");

      var noteColor = note === null ? null
        : note.level === "error" ? "var(--dsw-alias-state-error-primary)"
        : "var(--dsw-alias-state-success-primary)";
      var noteText = note === null ? (locked && formStatus === "ready" ? t("readOnly") : null) : note.text;

      function row(label, hint, control, fullWidth) {
        return React.createElement("div", {
          style: {
            display: "flex", alignItems: "flex-start", gap: "12px", flexWrap: "wrap",
            padding: "14px 0", borderTop: "0.5px solid var(--dsw-alias-border-l2)",
          },
        },
        React.createElement("div", {
          style: { flex: "1 1 200px", minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
        },
        React.createElement("span", {
          style: { fontSize: "13px", fontWeight: 500, lineHeight: "1.5", color: "var(--dsw-alias-label-primary)" },
        }, label),
        React.createElement("span", {
          style: { fontSize: "12px", lineHeight: "1.5", color: "var(--dsw-alias-label-tertiary)" },
        }, hint)),
        React.createElement("div", {
          style: {
            flex: fullWidth === true ? "1 1 100%" : "1 1 auto",
            minWidth: 0, display: "flex", alignItems: "center", gap: "8px",
            flexWrap: "wrap", justifyContent: "flex-end",
          },
        }, control));
      }

      var track = React.createElement("button", {
        type: "button",
        role: "switch",
        "aria-checked": settings.enabled,
        disabled: busy || locked,
        onClick: function () { void toggle(); },
        style: {
          width: "36px", height: "20px", padding: "0", border: "none",
          borderRadius: "10px", position: "relative", cursor: busy ? "default" : "pointer",
          background: settings.enabled
            ? "var(--dsw-alias-state-business-primary)"
            : "var(--dsw-alias-border-l4)",
          transition: "background 120ms ease",
        },
      }, React.createElement("span", {
        style: {
          position: "absolute", top: "2px", left: settings.enabled ? "18px" : "2px",
          width: "16px", height: "16px", borderRadius: "8px", background: "#fff",
          transition: "left 120ms ease",
        },
      }));

      return React.createElement("section", {
        "data-screenshot-bridge": "settings",
        style: { display: "flex", flexDirection: "column", gap: "4px", maxWidth: "720px" },
      },
      React.createElement("h2", {
        style: { margin: "0 0 2px", fontSize: "15px", fontWeight: 600, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" },
      }, t("title")),
      React.createElement("p", {
        style: { margin: "0 0 12px", fontSize: "12px", lineHeight: "1.6", color: "var(--dsw-alias-label-tertiary)" },
      }, t("intro")),
      React.createElement("div", {
        style: {
          padding: "0 16px",
          borderRadius: "var(--dsw-radius-md)",
          background: "var(--dsw-alias-bg-module-platform)",
        },
      },
      row(t("enabled"), t("enabledHint"), React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: "8px" },
      }, React.createElement("span", {
        style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
      }, settings.enabled ? t("on") : t("off")), track)),

      row(t("hotkeyLabel"), t("hotkeyHint"), React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" },
      },
      React.createElement("input", {
        value: recording ? t("recording") : hotkey,
        readOnly: recording,
        spellCheck: false,
        onChange: function (event) {
          dirtyHotkey.current = true;
          setHotkey(event.target.value);
        },
        onKeyDown: function (event) {
          if (event.key === "Enter") void commitHotkey(hotkey);
        },
        style: { ...INPUT_STYLE, width: "min(210px, 100%)", fontVariantNumeric: "tabular-nums" },
      }),
      React.createElement("button", {
        type: "button",
        style: SMALL_BUTTON_STYLE,
        disabled: locked,
        onClick: function () { setRecording(!recording); },
      }, recording ? t("recording") : t("record")),
      React.createElement("button", {
        type: "button",
        style: SMALL_BUTTON_STYLE,
        disabled: busy || locked,
        onClick: function () { void commitHotkey(hotkey); },
      }, t("save")))),

      row(t("sessionLabel"), t("sessionHint"), React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 },
      },
      React.createElement("input", {
        value: session,
        placeholder: t("sessionPlaceholder"),
        spellCheck: false,
        onChange: function (event) {
          dirtySession.current = true;
          setSession(event.target.value);
        },
        onKeyDown: function (event) {
          if (event.key === "Enter") void commitSession();
        },
        style: { ...INPUT_STYLE, flex: "1 1 180px", width: "min(320px, 100%)", maxWidth: "100%", minWidth: 0, fontFamily: "ui-monospace, monospace", fontSize: "12px" },
      }),
      React.createElement("button", {
        type: "button",
        style: SMALL_BUTTON_STYLE,
        disabled: busy || locked,
        onClick: function () { void commitSession(); },
      }, busy ? t("saving") : t("save")))),

      row(t("allScreensLabel"), t("allScreensHint"), React.createElement("button", {
        type: "button",
        role: "switch",
        "aria-checked": settings.allScreens,
        disabled: locked,
        style: {
          width: "36px", height: "20px", padding: "0", border: "none", borderRadius: "10px",
          position: "relative", cursor: locked ? "default" : "pointer",
          background: settings.allScreens ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-border-l4)",
        },
        onClick: function () {
          void writeField("allScreens", !settings.allScreens).then(function (ok) {
            if (!ok) setNote({ level: "error", text: t("saveFailed") });
            void fetchState();
          });
        },
      }, React.createElement("span", {
        style: {
          position: "absolute", top: "2px", left: settings.allScreens ? "18px" : "2px",
          width: "16px", height: "16px", borderRadius: "8px", background: "#fff",
        },
      }))),

      row(t("modeLabel"), t("modeHint"), React.createElement("div", {
        style: { display: "flex", alignItems: "center" },
      },
      React.createElement("button", {
        type: "button",
        disabled: busy || locked,
        "aria-pressed": settings.mode === "image",
        style: {
          padding: "4px 12px", fontSize: "12px", lineHeight: "20px",
          cursor: (busy || locked) ? "default" : "pointer",
          border: "0.5px solid var(--dsw-alias-border-l3)",
          borderRight: "none", borderRadius: "6px 0 0 6px",
          background: settings.mode === "image" ? "var(--dsw-alias-state-business-primary)" : "transparent",
          color: settings.mode === "image" ? "#fff" : "var(--dsw-alias-label-secondary)",
          fontWeight: settings.mode === "image" ? 600 : 400,
        },
        onClick: function () {
          if (settings.mode !== "image") void commitMode("image");
        },
      }, t("modeImage")),
      React.createElement("button", {
        type: "button",
        disabled: busy || locked,
        "aria-pressed": settings.mode === "extract",
        style: {
          padding: "4px 12px", fontSize: "12px", lineHeight: "20px",
          cursor: (busy || locked) ? "default" : "pointer",
          border: "0.5px solid var(--dsw-alias-border-l3)",
          borderRadius: "0 6px 6px 0",
          background: settings.mode === "extract" ? "var(--dsw-alias-state-business-primary)" : "transparent",
          color: settings.mode === "extract" ? "#fff" : "var(--dsw-alias-label-secondary)",
          fontWeight: settings.mode === "extract" ? 600 : 400,
        },
        onClick: function () {
          if (settings.mode !== "extract") void commitMode("extract");
        },
      }, t("modeExtract")))),

      row(t("promptLabel"), t("promptHint"), React.createElement("div", {
        style: {
          display: "flex", flexDirection: "column", alignItems: "stretch", gap: "8px",
          flex: "1 1 100%", minWidth: 0,
        },
      },
      React.createElement("textarea", {
        value: prompt,
        rows: 6,
        placeholder: t("promptPlaceholder"),
        readOnly: locked,
        spellCheck: false,
        onChange: function (event) {
          dirtyPrompt.current = true;
          setPrompt(event.target.value);
        },
        onKeyDown: function (event) {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void commitPrompt();
          }
        },
        style: {
          ...INPUT_STYLE, height: "auto", minHeight: "132px", width: "100%",
          boxSizing: "border-box", padding: "8px 10px", lineHeight: "1.6",
          resize: "vertical",
        },
      }),
      React.createElement("div", {
        style: { display: "flex", justifyContent: "flex-end", gap: "8px" },
      },
      React.createElement("button", {
        type: "button",
        style: SMALL_BUTTON_STYLE,
        disabled: busy || locked,
        onClick: function () { void commitPrompt(); },
      }, busy ? t("saving") : t("save")))), true),

      React.createElement("div", {
        style: {
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
          padding: "10px 0 2px", borderTop: "0.5px solid var(--dsw-alias-border-l2)",
          fontSize: "12px", color: "var(--dsw-alias-label-tertiary)",
        },
      },
      React.createElement("span", null, t("statusLabel") + " · " + hostLine),
      noteText === null ? null : React.createElement("span", {
        style: { color: noteColor ?? "var(--dsw-alias-label-tertiary)", textAlign: "right" },
      }, noteText))));
    }

    return {
      inject: ["slots", "locale", "sessions", "conversation", "configForms"],
      apply: function (ctx) {
        report("client-apply");
        ctx.effect(function () {
          return ctx.locale.register(NS, {
            zh: DICT.zh,
            en: DICT.en,
            ja: DICT.en,
            es: DICT.en,
            fr: DICT.en,
            de: DICT.en,
            ru: DICT.en,
            pt: DICT.en,
          });
        });
        translate = ctx.locale.bind(NS);

        ctx.effect(function () {
          try {
            form = ctx.configForms.get(ENTRY);
            if (form === null || form === undefined) throw new Error("config form unavailable");
            syncFromForm();
            var off = form.subscribe(syncFromForm);
            report("form init " + formStatus + " writable=" + String(form.getSnapshot().writable));
            void (async function () {
              var attempts = 0;
              while (attempts < 20 && formStatus === "loading") {
                await sleep(300);
                syncFromForm();
                attempts += 1;
              }
              await migrateStored();
            })();
            return function () { off(); };
          } catch (error) {
            form = null;
            formStatus = "unavailable";
            report("form unavailable " + messageOf(error));
            void migrateStored();
            return;
          }
        }, "screenshot-bridge: settings form");

        ctx.effect(function () {
          return startPolling(ctx);
        }, "screenshot-bridge: capture poll");

        ctx.effect(function () {
          return ctx.slots.inject("settings.section", function () {
            var dispose = ctx.slots.register({
              name: "settings.section",
              id: ENTRY,
              order: 60,
              label: function () { return tr("title"); },
              locale: NS,
              inject: function () { return { t: translate }; },
            }, SettingsCard);
            report("client-slot-settings");
            return dispose;
          });
        }, "screenshot-bridge: settings page");
      },
    };
  },
});
