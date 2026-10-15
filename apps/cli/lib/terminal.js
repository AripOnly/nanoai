// apps/cli/lib/terminal.js
// Terminal screen and scrollback buffer management.

export function clearTerminal() {
  if (process.stdout && process.stdout.isTTY) {
    // \x1B[2J: clear viewport, \x1B[3J: clear scrollback buffer, \x1B[H: cursor home
    process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
  } else {
    console.clear();
  }
}
