import assert from "node:assert/strict";
import test from "node:test";
import terminalAttentionExtension from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

test("tracks working spinner, background attention badge, and focus recovery", async () => {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    appendEntry() {},
  };

  terminalAttentionExtension(pi as never);

  const titles: string[] = [];
  let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/tmp/demo-project",
    isIdle: () => true,
    modelRegistry: { find: () => undefined },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "test-session",
    },
    ui: {
      setTitle(title: string) {
        titles.push(title);
      },
      onTerminalInput(fn: (data: string) => { consume?: boolean } | undefined) {
        terminalInput = fn;
        return () => {
          terminalInput = undefined;
        };
      },
    },
  };

  const emit = async (name: string, event: unknown = {}) => {
    for (const fn of handlers.get(name) ?? []) {
      await fn(event, ctx);
    }
  };

  await emit("session_start");
  assert.ok(terminalInput, "registers raw terminal input listener");

  await emit("agent_start");
  assert.equal(titles.at(-1), "•·· π · demo-project");

  assert.deepEqual(terminalInput("\x1b[O"), { consume: true });
  await emit("agent_settled", { aborted: false });

  if (process.platform !== "darwin") {
    assert.equal(titles.at(-1), "🔹 π · demo-project");
  }

  assert.deepEqual(terminalInput("\x1b[I"), { consume: true });
  assert.equal(titles.at(-1), "π · demo-project");

  await emit("session_shutdown");
  assert.equal(terminalInput, undefined);
});
