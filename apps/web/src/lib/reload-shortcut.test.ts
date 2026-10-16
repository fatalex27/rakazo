// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installReloadShortcut } from "./reload-shortcut";

describe("reload shortcut", () => {
  it("reloads once on Ctrl+R or Cmd+R, including inside an editor, and can be removed", () => {
    const reload = vi.fn();
    const remove = installReloadShortcut(window, reload);
    const input = document.createElement("input");
    document.body.append(input);
    const event = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", metaKey: true }));
    expect(reload).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true, altKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true, repeat: true }));
    expect(reload).toHaveBeenCalledTimes(2);
    remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true }));
    expect(reload).toHaveBeenCalledTimes(2);
    input.remove();
  });
});
