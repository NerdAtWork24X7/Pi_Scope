/**
 * terminal plugin — server half.
 *
 * Owns the `/terminal` WebSocket endpoint. The plugin host owns the server's
 * single `upgrade` listener (enablement, token auth, origin check, dispatch), so
 * this module only builds the terminal transport and registers its path and
 * lifecycle. Disabling the plugin closes live terminals and refuses new
 * upgrades with 403.
 */

export function activate(api: any): void {
  const {
    createTerminalTransport,
    terminalCwd,
    onTerminalCwdChange,
    onTerminalClose,
  } = api.kit;

  // Feature-detect: a host that predates the transport API cannot run this
  // plugin's server half.
  if (typeof createTerminalTransport !== "function") {
    api.log("terminal transport is unavailable on this host");
    return;
  }

  const terminal = createTerminalTransport({
    launchCwd: terminalCwd(),
    onCwdChange: onTerminalCwdChange,
    onClose: onTerminalClose,
  });

  api.transport("/terminal", (req: any, socket: any, head: any) => {
    terminal.upgrade(req, socket, head);
  });
  api.onDispose(() => terminal.close());
}
