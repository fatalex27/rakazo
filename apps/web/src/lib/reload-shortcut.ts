/** Electron's custom menu omits the default Reload accelerator; handle it in the shared UI. */
export function installReloadShortcut(
  target: Window = window,
  reload = () => target.location.reload(),
) {
  const onKey = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "r")
      return;
    event.preventDefault();
    if (!event.repeat) reload();
  };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}
