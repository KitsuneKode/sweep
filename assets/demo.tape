# sweep demo tape — regenerates assets/demo.gif (run from repo root):
#   vhs assets/demo.tape
# Seed fixture first:
#   mkdir -p /tmp/sweep-demo/{apps/web/{node_modules,dist,.next},apps/api/{node_modules,target},packages/core/{node_modules,dist}}
#   for d in $(find /tmp/sweep-demo -type d); do for i in 1 2 3; do dd if=/dev/urandom of="$d/blob$i.bin" bs=1024 count=$((RANDOM % 400 + 50)) 2>/dev/null; done; done
Output assets/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 720
Set Padding 18
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

Type "cd /tmp/sweep-demo && du -sh ."
Sleep 500ms
Enter
Sleep 800ms
Type "clear && bun /home/kitsunekode/Projects/cli-tools/sweep/apps/cli/src/bin.ts ui ."
Enter
Sleep 4s

Down
Sleep 300ms
Down
Sleep 300ms
Down
Sleep 300ms
Down
Sleep 400ms

Space
Sleep 400ms

Type "G"
Sleep 500ms
Type "?"
Sleep 900ms
Escape
Sleep 500ms
Type "gg"
Sleep 600ms

Escape
Sleep 800ms
