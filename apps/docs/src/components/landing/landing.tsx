import { Link } from "@tanstack/react-router";
import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import {
  Archive,
  ArrowRight,
  Ban,
  Check,
  Copy,
  Keyboard,
  ReceiptText,
  ScanSearch,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { InputCopy } from "@/components/ui/input-copy";
import { Slider } from "@/components/ui/slider";
import { TabItem, TabPanel, Tabs, TabsList } from "@/components/ui/tabs";
import {
  AGENT_PROMPT,
  AUTOMATION,
  BENCH,
  BENCH_FACTS,
  CATALOG,
  CATALOG_NAMES,
  ERROR_CODES,
  INSTALL,
  KEY_GROUPS,
  PHASES,
  STREAM_EVENTS,
  type Phase,
} from "./content";
import { QueueDemo } from "./queue-demo";

export function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  useReveal(rootRef);
  return (
    <div className="sw" ref={rootRef}>
      <Header />
      <main id="main-content" tabIndex={-1} className="sw-frame">
        <Hero />
        <CatalogStrip />
        <Idle />
        <Refuses />
        <Speed />
        <Keys />
        <Automation />
        <Start />
      </main>
      <Footer />
    </div>
  );
}

/* ── Shared pieces ──────────────────────────────────────────────────── */

function Wordmark() {
  return (
    <Link to="/" className="sw-wordmark" aria-label="Sweep home">
      <span className="sw-wordmark-tab" aria-hidden="true" />
      sweep
    </Link>
  );
}

function SectionHead({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <header className="sw-head" data-reveal>
      <h2 id={id}>{title}</h2>
      <div className="sw-head-aside">{children}</div>
    </header>
  );
}

/** A framed fragment of the product with a folder-tab label and a caption. */
function Panel({
  tab,
  icon: Icon,
  title,
  children,
  caption,
  className,
}: {
  tab: string;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  caption: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`sw-panel ${className ?? ""}`} data-reveal>
      <div className="sw-panel-stage">
        <span className="sw-panel-tab">{tab}</span>
        {children}
      </div>
      <figcaption>
        <p className="sw-panel-title">
          <Icon aria-hidden="true" />
          {title}
        </p>
        <p>{caption}</p>
      </figcaption>
    </figure>
  );
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  }, [text]);
  return [copied, copy] as const;
}

/* ── Header ─────────────────────────────────────────────────────────── */

function Header() {
  return (
    <header className="sw-top">
      <div className="sw-top-inner">
        <Wordmark />
        <nav aria-label="Primary" className="sw-top-nav">
          <Link to="/docs/$" params={{ _splat: "users/getting-started" }}>
            Docs
          </Link>
          <Link to="/docs/$" params={{ _splat: "users/safety" }}>
            Safety
          </Link>
          <Link to="/docs/$" params={{ _splat: "users/automation" }}>
            Automation
          </Link>
          <Link to="/docs/$" params={{ _splat: "developer/benchmarks" }}>
            Benchmarks
          </Link>
        </nav>
        <div className="sw-top-end">
          <ThemeSwitch className="sw-theme" />
          <a href="https://github.com/KitsuneKode/sweep">GitHub</a>
          <Link
            to="/docs/$"
            params={{ _splat: "users/getting-started" }}
            className="sw-btn sw-btn-light sw-btn-sm"
          >
            Install
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ── Hero: the product is the hero ──────────────────────────────────── */

function Hero() {
  const [phase, setPhase] = useState<Phase>("scan");
  const [copied, copy] = useCopy(AGENT_PROMPT);
  return (
    <section className="sw-hero" aria-labelledby="hero-title">
      <div className="sw-hero-grid">
        <div className="sw-hero-title">
          <h1 id="hero-title">
            Reclaim gigabytes. <br />
            Delete nothing by surprise.
          </h1>
        </div>
        <div className="sw-hero-copy">
          <p className="sw-hero-lead">
            sweep is a free, open-source CLI that finds node_modules, target, .next and other build
            output across your projects, shows what each one is, and removes only what you tick.
          </p>
          <div className="sw-hero-actions">
            <Link to="/docs/$" params={{ _splat: "users/getting-started" }} className="sw-btn">
              Get started <ArrowRight aria-hidden="true" />
            </Link>
            <button type="button" className="sw-btn sw-btn-ghost" onClick={copy}>
              <span className="sw-icon-swap" key={copied ? "done" : "idle"} aria-hidden="true">
                {copied ? <Check /> : <Copy />}
              </span>
              {copied ? "Prompt copied" : "Copy prompt for your coding agent"}
            </button>
          </div>
          <InputCopy
            data-ui
            className="sw-hero-cmd"
            value="npx @kitsunekode/sweep ui ."
            label="Or run it without installing"
          />
        </div>
        <div className="sw-hero-demo">
          <div className="sw-window" data-ui>
            <span className="sw-panel-tab">Try it · sample tree, not your disk</span>
            <QueueDemo onPhaseChange={setPhase} />
          </div>
        </div>
      </div>
      <ol className="sw-phases" aria-label="How a run goes">
        {PHASES.map((step) => (
          <li key={step.id} aria-current={step.id === phase ? "step" : undefined}>
            <span className="sw-phases-name">{step.name}</span>
            <span className="sw-phases-line">{step.line}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ── Catalog strip (the logo-cloud slot, with what it actually knows) ─ */

function CatalogStrip() {
  const row = CATALOG_NAMES.map((entry) => (
    <li key={entry.name} data-default={entry.byDefault}>
      <code>{entry.name}</code>
    </li>
  ));
  return (
    <section className="sw-catalog" aria-labelledby="catalog-title">
      <div className="sw-catalog-head">
        <h2 id="catalog-title">Knows {CATALOG_NAMES.length} kinds of build output</h2>
        <p>
          <span className="sw-legend sw-legend-on">On by default</span>
          <span className="sw-legend">Opt-in</span>
        </p>
      </div>
      <div className="sw-marquee">
        <ul>{row}</ul>
        <ul aria-hidden="true">{row}</ul>
      </div>
    </section>
  );
}

/* ── Idle projects: what a disk analyser cannot know ────────────────── */

/** An illustrative `sweep --dry-run` report: the shape the CLI prints. */
const REPORT_ROWS: { path: string; size: string; idle: string; picked: boolean }[] = [
  { path: "thesis-site/node_modules", size: "612 MiB", idle: "8mo", picked: true },
  { path: "old-api/target", size: "2.4 GiB", idle: "5mo", picked: true },
  { path: "game-jam/.next", size: "318 MiB", idle: "3mo", picked: true },
  { path: "shop/node_modules", size: "1.1 GiB", idle: "2h", picked: false },
];

const IDLE_FACTS: { term: string; detail: ReactNode }[] = [
  {
    term: "When you last worked on it",
    detail:
      "From the project's git index and history and its own files, never its build output. A reinstall does not make a forgotten project look busy.",
  },
  {
    term: "Idle projects first",
    detail: (
      <>
        <code>sweep --idle 30d</code> selects only what nobody has touched for a month. The terminal
        UI offers the same queue in one action.
      </>
    ),
  },
  {
    term: "What it does to your disk",
    detail:
      "Free space now and after, and a warning when the selection includes a project you worked on today: the next build brings it straight back.",
  },
];

function Idle() {
  return (
    <section className="sw-section" aria-labelledby="idle-title">
      <SectionHead id="idle-title" title="Knows which projects you left">
        <p>
          A disk analyser sees sizes. sweep also sees when you last touched the project around each
          folder, so the easy wins come first and today's work stays put.{" "}
          <Link to="/docs/$" params={{ _splat: "users/commands" }}>
            Read about --idle
          </Link>
        </p>
      </SectionHead>
      <div className="sw-idle">
        <figure className="sw-report" data-ui data-reveal>
          <span className="sw-panel-tab">sweep --dry-run · illustrative</span>
          <p className="sw-report-head">
            <strong>4.4 GiB</strong> to reclaim · 3 of 4 selected
          </p>
          <p className="sw-report-dim">disk 9.6 GiB free of 256 GiB → up to 14.0 GiB free</p>
          <p className="sw-report-warn">! 1.1 GiB is in a project worked on today (shop)</p>
          <p className="sw-report-tip">
            → 3.3 GiB is in projects idle 30+ days: <span>sweep --idle 30d</span>
          </p>
          <ul>
            {REPORT_ROWS.map((row) => (
              <li key={row.path} data-picked={row.picked}>
                <span aria-hidden="true">{row.picked ? "●" : "○"}</span>
                <span>{row.path}</span>
                <span>{row.size}</span>
                <span>idle {row.idle}</span>
              </li>
            ))}
          </ul>
        </figure>
        <dl className="sw-idle-facts">
          {IDLE_FACTS.map((fact) => (
            <div key={fact.term} data-reveal>
              <dt>{fact.term}</dt>
              <dd>{fact.detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ── Built to refuse: the bento ─────────────────────────────────────── */

const REFUSAL_ROWS: [string, string, string][] = [
  ["Filesystem roots", "Scan target", "Refused"],
  ["Anything inside .git", "Any candidate", "Blocked"],
  ["Replaced since the scan", "Entry at apply", "Refused"],
  ["Replaced scan root", "Whole apply", "Refused"],
  ["Mount crossings (Linux)", "During removal", "Refused"],
  ["Incomplete scan", "Apply and export", "Blocked"],
  ["Over the size ceiling", "Apply", "Needs --force-large"],
];

function Refuses() {
  const [active, setActive] = useState(0);
  const item = CATALOG[active]!;
  return (
    <section className="sw-section" aria-labelledby="refuses-title">
      <SectionHead id="refuses-title" title="Built to refuse">
        <p>
          A name match is a candidate, not a verdict. sweep explains every item, checks it again
          right before removal, and accounts for every outcome.{" "}
          <Link to="/docs/$" params={{ _splat: "users/safety" }}>
            Read the safety model
          </Link>
        </p>
      </SectionHead>

      <div className="sw-bento">
        <Panel
          tab="inspect"
          icon={ScanSearch}
          title="Every item explains itself"
          caption="Pattern, reason, default and risk tier, visible before anything is selected."
        >
          <div className="sw-inspect" data-ui>
            <ul className="sw-inspect-picks" aria-label="Pick an artifact kind">
              {CATALOG.map((entry, index) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    aria-pressed={index === active}
                    onClick={() => setActive(index)}
                  >
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
            <dl key={item.name}>
              <div>
                <dt>Path</dt>
                <dd>{item.example}</dd>
              </div>
              <div>
                <dt>Why</dt>
                <dd>{item.note}</dd>
              </div>
              <div>
                <dt>Default</dt>
                <dd>{item.byDefault ? "on" : "opt-in"}</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd data-tier={item.byDefault ? "safe" : "dangerous"}>
                  {item.byDefault ? "safe" : "dangerous"}
                </dd>
              </div>
              <div>
                <dt>Selected</dt>
                <dd>no, until you tick it</dd>
              </div>
            </dl>
          </div>
        </Panel>

        <Panel
          tab="apply · illustrative"
          icon={ShieldCheck}
          title="Checked again at apply"
          caption="Scans record each entry's filesystem identity. An entry replaced since then is refused."
        >
          <div className="sw-log" data-ui>
            <p className="sw-log-cmd">$ sweep apply --plan sweep-plan.json</p>
            <p>
              <span data-tier="safe">removed</span> engine/target
            </p>
            <p>
              <span data-tier="safe">removed</span> web/node_modules
            </p>
            <p>
              <span data-tier="dangerous">refused</span> web/.next
            </p>
            <p className="sw-log-why">replaced since the scan</p>
          </div>
        </Panel>

        <Panel
          tab="receipt"
          icon={ReceiptText}
          title="Every run ends in a receipt"
          caption="Completed, failed and unattempted items, reported separately. Stopping never undoes completed work."
        >
          <div className="sw-paper" data-ui>
            <p className="sw-paper-title">Cleanup receipt</p>
            <dl>
              <div>
                <dt>Completed</dt>
                <dd>2</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd>1</dd>
              </div>
              <div>
                <dt>Unattempted</dt>
                <dd>0</dd>
              </div>
              <div className="sw-paper-total">
                <dt>Freed</dt>
                <dd>3.2 GB</dd>
              </div>
            </dl>
          </div>
        </Panel>

        <Panel
          tab="guardrails"
          icon={Ban}
          title="Refusals no flag can talk past"
          caption="These hold however a run starts: terminal UI, plan file or agent."
          className="sw-panel-wide"
        >
          <table className="sw-rules" data-ui>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Applies to</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {REFUSAL_ROWS.map(([rule, scope, result]) => (
                <tr key={rule}>
                  <td>
                    <span className="sw-rules-box" aria-hidden="true" />
                    {rule}
                  </td>
                  <td>{scope}</td>
                  <td>
                    <span className="sw-rules-result">{result}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel
          tab="trash"
          icon={Archive}
          title="Trash stays local"
          caption="Trash mode moves items into the scan target. It keeps the disk space until you clear it."
        >
          <div className="sw-tree" data-ui>
            <p>~/projects/</p>
            <p className="sw-tree-hl">└ .sweep-trash-1761400000/</p>
            <p className="sw-tree-in">├ engine/target</p>
            <p className="sw-tree-in">└ web/node_modules</p>
            <p className="sw-tree-note">3.2 GB · still on disk</p>
          </div>
        </Panel>
      </div>
    </section>
  );
}

/* ── Speed: one dot per candidate ───────────────────────────────────── */

/** Linear between the two measured runs; never extrapolated past them. */
function estimateMs(candidates: number): number {
  const { low, high } = BENCH;
  const t = Math.max(0, (candidates - low.candidates) / (high.candidates - low.candidates));
  return low.ms + t * (high.ms - low.ms);
}

function Speed() {
  const [count, setCount] = useState(200);
  const cols = 32;
  const full = Math.floor(count / cols);
  const rest = count % cols;
  const rowPct = (n: number) => `${(n / cols) * 100}%`;
  const clip = `polygon(0 0, 100% 0, 100% ${rowPct(full)}, ${rowPct(rest)} ${rowPct(full)}, ${rowPct(rest)} ${rowPct(full + 1)}, 0 ${rowPct(full + 1)})`;
  return (
    <section className="sw-section" aria-labelledby="speed-title">
      <SectionHead id="speed-title" title="Fast enough to stay out of the way">
        <p>
          The Rust engine streams the first result in about two milliseconds, so the list fills
          while you are still reading it. Set a tree size and see the measured median.
        </p>
      </SectionHead>
      <div className="sw-speed" data-reveal>
        <div className="sw-matrix" aria-hidden="true">
          <span className="sw-matrix-on" style={{ clipPath: clip }} />
        </div>
        <div className="sw-speed-read">
          <div className="sw-slider" data-ui>
            <Slider
              label="Candidates found"
              value={count}
              onChange={(value) => setCount(value as number)}
              min={BENCH.low.candidates}
              max={BENCH.high.candidates}
              step={8}
              formatValue={(value) => value.toLocaleString("en")}
            />
          </div>
          <p className="sw-figure" aria-live="polite">
            {estimateMs(count).toFixed(1)}
            <span>ms</span>
          </p>
          <p className="sw-figure-note">
            Median scan to plan, interpolated between measured runs of {BENCH.low.candidates} and{" "}
            {BENCH.high.candidates.toLocaleString("en")} candidates. {BENCH.cpu}, warm cache. One
            dot is one candidate.
          </p>
        </div>
      </div>
      <ul className="sw-facts">
        {BENCH_FACTS.map((fact) => (
          <li key={fact.label} data-reveal>
            <p className="sw-facts-figure">{fact.figure}</p>
            <p>{fact.label}</p>
            <p className="sw-facts-detail">{fact.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Keys ───────────────────────────────────────────────────────────── */

function Keys() {
  return (
    <section className="sw-section" aria-labelledby="keys-title">
      <SectionHead id="keys-title" title="Made for the terminal. Fine with a mouse.">
        <p>
          Arrows work everywhere; letters are speed aliases. Esc unwinds one layer at a time and
          never quits, so a stray key cannot cost you a review.
        </p>
      </SectionHead>
      <div className="sw-keys">
        <div className="sw-keys-tabs" data-reveal>
          <Keyboard aria-hidden="true" className="sw-keys-icon" />
          <Tabs defaultValue={KEY_GROUPS[0]!.group}>
            <TabsList>
              {KEY_GROUPS.map((group) => (
                <TabItem key={group.group} value={group.group} label={group.group} />
              ))}
            </TabsList>
            {KEY_GROUPS.map((group) => (
              <TabPanel key={group.group} value={group.group}>
                <ul className="sw-keylist">
                  {group.rows.map(([action, key]) => (
                    <li key={action}>
                      <span>{action}</span>
                      <KeyCombo keys={key} />
                    </li>
                  ))}
                </ul>
              </TabPanel>
            ))}
          </Tabs>
        </div>
        <div className="sw-statusline" data-ui data-reveal aria-label="Example statusline">
          <span className="sw-panel-tab">statusline</span>
          <p className="sw-statusline-row">
            <span className="sw-statusline-mode">FILTER</span>
            <span>/kind:node_modules &gt;100MB !path:web</span>
            <span className="sw-statusline-end">1 of 8</span>
          </p>
          <ul className="sw-statusline-rows">
            <li>
              <span className="sw-statusline-box" aria-hidden="true" />
              <span>api/node_modules</span>
              <span>412 MB</span>
              <span className="sw-statusline-safe">safe</span>
            </li>
          </ul>
          <p className="sw-statusline-muted">
            7 hidden by the filter. Review still names every queued artifact.
          </p>
          <p className="sw-statusline-hints">
            <span>
              <kbd>Space</kbd> toggle
            </span>
            <span>
              <kbd>s</kbd> queue safe
            </span>
            <span>
              <kbd>Esc</kbd> clear filter
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}

/** "↑ ↓ or j k" → keycaps for keys, plain text for words like "or". */
const KEY_TOKEN = /^(?:[↑↓/]|[a-zA-Z]|F\d+|Space|Esc|Enter|Ctrl[-+].+)$/;
function KeyCombo({ keys }: { keys: string }) {
  return (
    <span className="sw-combo">
      {keys
        .split(" ")
        .map((token, index) =>
          KEY_TOKEN.test(token) ? (
            <kbd key={`${token}-${index}`}>{token}</kbd>
          ) : (
            <span key={`${token}-${index}`}>{token}</span>
          ),
        )}
    </span>
  );
}

/* ── Automation ─────────────────────────────────────────────────────── */

function Automation() {
  return (
    <section className="sw-section" aria-labelledby="auto-title">
      <SectionHead id="auto-title" title="Same rules for scripts and agents">
        <p>
          Plans, previews and streams go through the validated paths the terminal UI uses. Evidence
          comes first; deletion is a separate, approved step.{" "}
          <Link to="/docs/$" params={{ _splat: "users/automation" }}>
            Read the automation guide
          </Link>
        </p>
      </SectionHead>
      <div className="sw-auto">
        <div className="sw-auto-code" data-reveal>
          <Workflow aria-hidden="true" className="sw-keys-icon" />
          <Tabs defaultValue={AUTOMATION[0]!.id}>
            <TabsList>
              {AUTOMATION.map((step) => (
                <TabItem key={step.id} value={step.id} label={step.label} />
              ))}
            </TabsList>
            {AUTOMATION.map((step) => (
              <TabPanel key={step.id} value={step.id} className="sw-auto-panel">
                <pre>
                  <code>
                    <span className="sw-prompt">$ </span>
                    {step.command}
                  </code>
                </pre>
                <p>{step.note}</p>
              </TabPanel>
            ))}
          </Tabs>
        </div>
        <Panel
          tab="--json-stream"
          icon={Workflow}
          title="A lifecycle you can check"
          caption="Treat a nonzero exit or a missing scan_completed as incomplete."
        >
          <ol className="sw-events" data-ui>
            {STREAM_EVENTS.map((event) => (
              <li key={event}>{event}</li>
            ))}
          </ol>
        </Panel>
        <Panel
          tab="errors"
          icon={ShieldCheck}
          title="Failures stay failures"
          caption="Fatal errors end stderr with a JSON record. Only lock contention is retryable."
        >
          <table className="sw-codes" data-ui>
            <tbody>
              {ERROR_CODES.map((error) => (
                <tr key={error.code}>
                  <th scope="row">{error.code}</th>
                  <td>{error.meaning}</td>
                  <td data-retry={error.retry}>{error.retry ? "retry" : "stop"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </section>
  );
}

/* ── Start: the sentence with a blank, on a textured band ───────────── */

function Start() {
  const [path, setPath] = useState("~/projects");
  const command = `bunx @kitsunekode/sweep ui ${path.trim() || "."}`;
  const [copied, copy] = useCopy(command);
  return (
    <section className="sw-start" aria-labelledby="start-title">
      <form
        className="sw-start-form"
        data-reveal
        onSubmit={(event) => {
          event.preventDefault();
          void copy();
        }}
      >
        <h2 id="start-title">
          Point sweep at{" "}
          <input
            aria-label="Folder to scan"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />{" "}
          and <button type="submit">{copied ? "copied" : "copy"}</button>
        </h2>
        <p className="sw-start-note" aria-live="polite">
          {copied ? "Copied " : "Copies "}
          <code>{command}</code>. Scanning changes nothing; the queue starts empty.
        </p>
      </form>
      <div className="sw-install" data-reveal>
        <p>Or install it for good</p>
        <Tabs defaultValue={INSTALL[0]!.id}>
          <TabsList>
            {INSTALL.map((method) => (
              <TabItem key={method.id} value={method.id} label={method.label} />
            ))}
          </TabsList>
          {INSTALL.map((method) => (
            <TabPanel key={method.id} value={method.id} className="sw-install-panel">
              <InputCopy value={method.command} label={`${method.label} install command`} />
            </TabPanel>
          ))}
        </Tabs>
      </div>
    </section>
  );
}

/* ── Footer ─────────────────────────────────────────────────────────── */

const FOOT_COLUMNS: { title: string; links: [string, string][] }[] = [
  {
    title: "Use",
    links: [
      ["Getting started", "users/getting-started"],
      ["Terminal UI", "users/terminal-ui"],
      ["Safety and trash", "users/safety"],
      ["Automation", "users/automation"],
    ],
  },
  {
    title: "Reference",
    links: [
      ["Commands", "users/commands"],
      ["Configuration", "users/configuration"],
      ["Platforms", "users/platforms"],
      ["Troubleshooting", "users/troubleshooting"],
    ],
  },
  {
    title: "Project",
    links: [
      ["Architecture", "developer/architecture"],
      ["Benchmarks", "developer/benchmarks"],
      ["Roadmap", "developer/roadmap"],
      ["Contributing", "developer/contributing"],
    ],
  },
];

function Footer() {
  return (
    <footer className="sw-foot">
      <div className="sw-foot-inner">
        <div className="sw-foot-brand">
          <Wordmark />
          <p>Find build artifacts. Remove only what you choose.</p>
        </div>
        <nav className="sw-foot-links" aria-label="Footer">
          {FOOT_COLUMNS.map((column) => (
            <div key={column.title} className="sw-foot-col">
              <p>{column.title}</p>
              {column.links.map(([label, splat]) => (
                <Link key={splat} to="/docs/$" params={{ _splat: splat }}>
                  {label}
                </Link>
              ))}
            </div>
          ))}
          <div className="sw-foot-col">
            <p>Elsewhere</p>
            <a href="https://github.com/KitsuneKode/sweep">GitHub</a>
            <a href="https://www.npmjs.com/package/@kitsunekode/sweep">npm</a>
            <Link to="/docs/$" params={{ _splat: "users/privacy" }}>
              Privacy
            </Link>
          </div>
        </nav>
        <div className="sw-foot-last">
          <p>MIT licence · KitsuneKode</p>
          <a href="#main-content">Back to top</a>
        </div>
      </div>
      <p className="sw-foot-word" aria-hidden="true">
        sweep
      </p>
    </footer>
  );
}

/**
 * Staggered entrances. Content is visible without script; below-the-fold
 * parts are hidden only once this runs, then revealed once on entry.
 */
function useReveal(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!("IntersectionObserver" in window)) return;
    const parts = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
    const pending = parts.filter((el) => el.getBoundingClientRect().top > innerHeight * 0.9);
    for (const el of pending) el.dataset.reveal = "wait";
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const siblings = pending.filter((p) => p.parentElement === el.parentElement);
          // Large items: 80ms steps, capped so the last one is never late.
          el.style.setProperty("--d", `${Math.min(3, Math.max(0, siblings.indexOf(el))) * 80}ms`);
          el.dataset.reveal = "in";
          observer.unobserve(el);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of pending) observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef]);
}
