# sweep demo tape — regenerates assets/demo.gif (run from repo root):
#   vhs assets/demo.tape
# Seed fixture first (needs `sweep` on PATH - symlink apps/cli/dist/sweep.js):
#   rm -rf /tmp/sweep-demo && mkdir -p /tmp/sweep-demo/{apps/web/{node_modules,dist,.next,coverage},apps/api/{node_modules,target},apps/mobile/{node_modules,build},packages/core/{node_modules,dist},packages/cli/{node_modules,out},vendor/legacy/target}
#   for d in $(find /tmp/sweep-demo -type d); do n=$([ "${d##*/}" = node_modules ] && echo 5 || echo 2); for i in $(seq $n); do dd if=/dev/urandom of="$d/blob$i.bin" bs=1024 count=$((RANDOM % 900 + 200)) 2>/dev/null; done; done
#   touch -d "3 months ago" /tmp/sweep-demo/packages/cli/out /tmp/sweep-demo/vendor/legacy/target
Output assets/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 720
Set Padding 18
Set TypingSpeed 40ms
Set Theme {
  "foreground": "#e5e5e5",
  "background": "#0a0a0a",
  "black": "#0a0a0a",
  "red": "#ef4444",
  "green": "#7c9082",
  "yellow": "#a0aa88",
  "blue": "#6b7280",
  "magenta": "#8b9d83",
  "cyan": "#7c9082",
  "white": "#e5e5e5",
  "brightBlack": "#2a2a2a",
  "brightGreen": "#8b9d83"
}

# The stakes: a tree full of build artifacts
Type "cd /tmp/sweep-demo && du -sh ."
Sleep 400ms
Enter
Sleep 900ms

# The tool: TUI opens instantly, streams the scan in live
Type "clear && sweep ui ."
Enter
Sleep 3s

# Queue everything safe in one keystroke
Type "s"
Sleep 800ms

# Filter tease - live narrowing
Type "/node_modules"
Sleep 1100ms
Escape
Sleep 500ms

# Apply - the confirm gate (never skips this)
Type "g"
Sleep 400ms
Enter
Sleep 1300ms

# Confirm - apply runs, prints "Cleaned N items", exits to shell
Type "y"
Sleep 2s

# The payoff - tree shrinks, lifetime counter grows
Type "du -sh . && sweep stats"
Enter
Sleep 2.8s
