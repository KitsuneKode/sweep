import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor } from "./shared.js";

const COMMANDS = [
  "clean",
  "scan",
  "plan",
  "ui",
  "apply",
  "init",
  "doctor",
  "stats",
  "inspect",
  "completions",
] as const;

const SHARED_OPTIONS = [
  "--pattern",
  "--ignore",
  "--disabled-pattern",
  "--depth",
  "--select",
  "--include-dangerous",
  "--config",
  "--engine",
  "--no-color",
  "--json",
  "--quiet",
  "--verbose",
  "--yes",
  "--help",
  "--version",
];

const CLEAN_OPTIONS = [...SHARED_OPTIONS, "--dry-run", "--trash", "--force-large"];
const SCAN_OPTIONS = [...SHARED_OPTIONS, "--json-stream"];
const APPLY_OPTIONS = ["--plan", "--engine", "--trash", "--force-large", "--json", "--yes"];

const BASH_SCRIPT = `# sweep bash completion — install:
#   sweep completions bash > "$(brew --prefix 2>/dev/null)/etc/bash_completion.d/sweep" 2>/dev/null \\
#     || sweep completions bash > ~/.local/share/bash-completion/completions/sweep
_sweep() {
  local cur prev commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${COMMANDS.join(" ")}"

  case "$prev" in
    sweep)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      return 0
      ;;
    --engine)      COMPREPLY=($(compgen -W "auto js rust" -- "$cur")); return 0 ;;
    --select)      COMPREPLY=($(compgen -W "default safe all none" -- "$cur")); return 0 ;;
    --config|--plan|--ignore|--pattern|--disabled-pattern)
      COMPREPLY=($(compgen -f -- "$cur")); return 0 ;;
    --depth)       COMPREPLY=($(compgen -W "-1 0 1 2 3 4 5" -- "$cur")); return 0 ;;
    completions)   COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")); return 0 ;;
  esac

  case "\${COMP_WORDS[1]}" in
    clean|ui)      COMPREPLY=($(compgen -W "${CLEAN_OPTIONS.join(" ")}" -f -- "$cur")) ;;
    scan|plan)     COMPREPLY=($(compgen -W "${SCAN_OPTIONS.join(" ")}" -f -- "$cur")) ;;
    apply|inspect) COMPREPLY=($(compgen -W "${APPLY_OPTIONS.join(" ")}" -f -- "$cur")) ;;
    *)             COMPREPLY=($(compgen -W "${SHARED_OPTIONS.join(" ")} ${CLEAN_OPTIONS.join(" ")}" -f -- "$cur")) ;;
  esac
}
complete -F _sweep sweep
`;

const ZSH_SCRIPT = `#compdef sweep
# sweep zsh completion — install:
#   sweep completions zsh > ~/.zsh/completions/_sweep   # (dir must be in $fpath)
_sweep() {
  local -a commands
  commands=(
${COMMANDS.map((c) => `    '${c}:sweep ${c}'`).join("\n")}
  )
  local -a shared_options
  shared_options=(
${SHARED_OPTIONS.map((o) => `    '${o}[sweep option]'`).join("\n")}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    _arguments $shared_options
    return
  fi
  case "$words[2]" in
    apply|inspect) _arguments '--plan[plan file]:plan file:_files' '--engine[engine]:(auto js rust)' '--trash[reversible]' '--force-large[bypass size cap]' '--json[json output]' ;;
    *) _arguments $shared_options '--dry-run[preview]' '--trash[reversible]' '--force-large[bypass size cap]' '*:path:_files -/' ;;
  esac
}
_sweep "$@"
`;

const FISH_SCRIPT = `# sweep fish completion — install:
#   sweep completions fish > ~/.config/fish/completions/sweep.fish
${COMMANDS.map(
  (c) => `complete -c sweep -f -n "__fish_use_subcommand" -a ${c} -d "sweep ${c}"`,
).join("\n")}
complete -c sweep -n "__fish_seen_subcommand_from apply inspect" -l plan -r -F -d "saved plan file"
complete -c sweep -l engine -xa "auto js rust"
complete -c sweep -l select -xa "default safe all none"
complete -c sweep -l config -r -F
complete -c sweep -s p -l pattern -r
complete -c sweep -s i -l ignore -r
complete -c sweep -l disabled-pattern -r
complete -c sweep -l depth -x
complete -c sweep -s n -l dry-run -d "preview deletions"
complete -c sweep -l trash -d "move to .sweep-trash instead of deleting"
complete -c sweep -l force-large -d "bypass maxSizeGB cap"
complete -c sweep -s y -l yes -d "skip confirmation"
complete -c sweep -l json -d "JSON output"
complete -c sweep -l json-stream -d "NDJSON scan events"
complete -c sweep -s q -l quiet -d "minimal output"
complete -c sweep -l verbose -d "per-candidate progress"
complete -c sweep -l no-color -d "disable colors"
complete -c sweep -l include-dangerous -d "include dangerous candidates"
`;

const SCRIPTS: Record<string, string> = {
  bash: BASH_SCRIPT,
  zsh: ZSH_SCRIPT,
  fish: FISH_SCRIPT,
};

/** `sweep completions <shell>` — print a static completion script to stdout. */
export async function handleCompletions(shell: string, opts: { color: boolean }): Promise<void> {
  applyNoColor(opts.color);

  try {
    const script = SCRIPTS[shell];
    if (!script) {
      const { printError } = await import("@kitsunekode/sweep-display");
      printError(`Unknown shell "${shell}". Supported: ${Object.keys(SCRIPTS).join(", ")}`);
      exitWith(EXIT.GUARDRAIL);
    }
    process.stdout.write(script);
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
