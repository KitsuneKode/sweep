import type { Command } from "commander";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor, warnIgnoredOptions } from "./shared.js";
import { JsonOutput } from "../json-output.js";

/** Options whose value is a filesystem path - shells complete files for them. */
const FILE_VALUE_OPTIONS = new Set([
  "--config",
  "--plan",
  "--ignore",
  "--pattern",
  "--disabled-pattern",
]);

/** Options whose value comes from a fixed set - complete the words, not files. */
const WORD_VALUE_OPTIONS: Record<string, string> = {
  "--engine": "auto js rust",
  "--select": "default safe all none",
  "--resource-profile": "balanced low-memory",
  "--max-size-gb": "none",
};

/**
 * Options on the root program that belong to the bare `sweep` (clean) action -
 * they do not apply after a subcommand (`sweep stats --dry-run` is rejected).
 */
const ROOT_ACTION_OPTIONS = new Set(["--dry-run", "--trash", "--force-large"]);

interface CompletionModel {
  commands: string[];
  /** Long flags shared by every command (program globals + implicit help/version). */
  globalFlags: string[];
  /** Bare `sweep` flags - globals plus the clean-action options. */
  rootFlags: string[];
  /** Per-command long flags, globals excluded. */
  commandFlags: Record<string, string[]>;
}

function longFlags(command: Command): string[] {
  return command.options
    .map((option) => option.long)
    .filter((flag): flag is string => Boolean(flag));
}

/**
 * Derive the completion model from the live Commander program. Hand-maintained
 * flag lists drifted before (plan completing --json-stream, inspect completing
 * --engine) - generating from the program makes drift structurally impossible.
 */
function buildModel(program: Command): CompletionModel {
  const root = longFlags(program);
  // --version registers on program.options via .version(); --help does not.
  const implicit = root.includes("--help") ? [] : ["--help"];
  const globalFlags = [...root.filter((flag) => !ROOT_ACTION_OPTIONS.has(flag)), ...implicit];
  const commandFlags: Record<string, string[]> = {};
  for (const command of program.commands) {
    commandFlags[command.name()] = longFlags(command);
  }
  return {
    commands: Object.keys(commandFlags),
    globalFlags,
    rootFlags: [...root, ...implicit],
    commandFlags,
  };
}

function flagsFor(model: CompletionModel, command: string): string[] {
  return [...model.globalFlags, ...(model.commandFlags[command] ?? [])];
}

function bashScript(model: CompletionModel): string {
  const cases = model.commands
    .map(
      (command) =>
        `    ${command}) COMPREPLY=($(compgen -W "${flagsFor(model, command).join(" ")}" -f -- "$cur")) ;;`,
    )
    .join("\n");
  const valueCases = [
    ...Object.entries(WORD_VALUE_OPTIONS).map(
      ([flag, words]) => `    ${flag}) COMPREPLY=($(compgen -W "${words}" -- "$cur")); return 0 ;;`,
    ),
    `    ${[...FILE_VALUE_OPTIONS].join("|")}) COMPREPLY=($(compgen -f -- "$cur")); return 0 ;;`,
    `    completions) COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")); return 0 ;;`,
  ].join("\n");

  return `# sweep bash completion. Install:
#   sweep completions bash > "$(brew --prefix 2>/dev/null)/etc/bash_completion.d/sweep" 2>/dev/null \\
#     || sweep completions bash > ~/.local/share/bash-completion/completions/sweep
_sweep() {
  local cur prev commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${model.commands.join(" ")}"

  case "$prev" in
    sweep)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      return 0
      ;;
${valueCases}
  esac

  case "\${COMP_WORDS[1]}" in
${cases}
    *) COMPREPLY=($(compgen -W "${model.rootFlags.join(" ")}" -f -- "$cur")) ;;
  esac
}
complete -F _sweep sweep
`;
}

function zshScript(model: CompletionModel): string {
  const commandEntries = model.commands
    .map((command) => `    '${command}:sweep ${command}'`)
    .join("\n");
  const flagEntries = model.globalFlags.map((flag) => `    '${flag}[sweep option]'`).join("\n");
  const cases = model.commands
    .map((command) => {
      const flags = flagsFor(model, command)
        .map((flag) => `'${flag}[sweep option]'`)
        .join(" ");
      return `    ${command}) _arguments ${flags} '*:path:_files -/' ;;`;
    })
    .join("\n");

  return `#compdef sweep
# sweep zsh completion. Install:
#   sweep completions zsh > ~/.zsh/completions/_sweep   # (dir must be in $fpath)
_sweep() {
  local -a commands
  commands=(
${commandEntries}
  )
  local -a shared_options
  shared_options=(
${flagEntries}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    _arguments $shared_options
    return
  fi
  case "$words[2]" in
${cases}
    *) _arguments ${model.rootFlags.map((flag) => `'${flag}[sweep option]'`).join(" ")} '*:path:_files -/' ;;
  esac
}
_sweep "$@"
`;
}

function fishScript(model: CompletionModel, program: Command): string {
  const commandLines = model.commands
    .map(
      (command) =>
        `complete -c sweep -f -n "__fish_use_subcommand" -a ${command} -d "sweep ${command}"`,
    )
    .join("\n");

  // One completion line per flag. Command-specific flags are gated on their
  // subcommand so `sweep inspect --trash` never completes.
  const flagLines: string[] = [];
  const seenGlobal = new Set<string>();
  for (const command of program.commands) {
    const name = command.name();
    for (const option of command.options) {
      if (!option.long) continue;
      const gated = `-n "__fish_seen_subcommand_from ${name}"`;
      flagLines.push(
        `complete -c sweep ${gated} -l ${option.long.slice(2)}${option.required || option.optional ? " -r" : ""}${FILE_VALUE_OPTIONS.has(option.long) ? " -F" : ""} -d "${option.description.replace(/"/g, "'")}"`,
      );
    }
  }
  for (const option of program.options) {
    if (!option.long || seenGlobal.has(option.long)) continue;
    seenGlobal.add(option.long);
    const words = WORD_VALUE_OPTIONS[option.long];
    // Root-action flags (--dry-run/--trash/--force-large on the bare `sweep`
    // clean action) only apply before a subcommand is typed.
    const gate = ROOT_ACTION_OPTIONS.has(option.long) ? ' -n "__fish_use_subcommand"' : "";
    flagLines.push(
      `complete -c sweep${gate} -l ${option.long.slice(2)}${words ? ` -xa "${words}"` : option.required || option.optional ? " -r" : ""}${FILE_VALUE_OPTIONS.has(option.long) ? " -F" : ""} -d "${option.description.replace(/"/g, "'")}"`,
    );
  }
  flagLines.push('complete -c sweep -l help -d "show help"');

  return `# sweep fish completion. Install:
#   sweep completions fish > ~/.config/fish/completions/sweep.fish
${commandLines}
${flagLines.join("\n")}
`;
}

/** Render one shell's completion script; undefined for an unknown shell. */
export function renderCompletions(shell: string, program: Command): string | undefined {
  const model = buildModel(program);
  if (shell === "bash") return bashScript(model);
  if (shell === "zsh") return zshScript(model);
  if (shell === "fish") return fishScript(model, program);
  return undefined;
}

/** `sweep completions <shell>` - print a completion script generated from the program. */
export async function handleCompletions(
  shell: string,
  opts: CliOptions,
  program: Command,
): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "completions");

  try {
    const script = renderCompletions(shell, program);
    if (!script) {
      const { printError } = await import("@kitsunekode/sweep-display");
      printError(`Unknown shell "${shell}". Supported: bash, zsh, fish`);
      exitWith(EXIT.GUARDRAIL);
    }
    const output = new JsonOutput(process.stdout);
    output.write(script);
    await output.flush();
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
