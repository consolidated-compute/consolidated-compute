import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { CC_PRODUCT_NAME, CC_REPOSITORY_URL } from "~/site-identity";
import "~/styles.css";

const TEXT_LINK =
  "underline underline-offset-4 decoration-muted-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-4";
const CAPABILITIES_PARAMS = { _splat: "capabilities" };
const FIRST_TEAM_PARAMS = { _splat: "github-work" };

export function CcHome() {
  return (
    <div className="max-w-6xl mx-auto px-6 md:px-10">
      <a href="#main" className="sr-only focus:not-sr-only focus:block focus:py-4">
        Skip to content
      </a>
      <header className="flex flex-wrap items-center justify-between gap-4 py-6 border-b border-border">
        <Link to="/" className="text-lg font-medium">
          {CC_PRODUCT_NAME}
        </Link>
        <nav aria-label="Main navigation" className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
          <Link to="/docs" className={TEXT_LINK}>
            Documentation
          </Link>
          <Link to="/docs/$" params={CAPABILITIES_PARAMS} className={TEXT_LINK}>
            Capabilities and evidence
          </Link>
          <a href={CC_REPOSITORY_URL} className={TEXT_LINK}>
            GitHub
          </a>
        </nav>
      </header>

      <main id="main">
        <section aria-labelledby="hero-title" className="pt-16 md:pt-24 pb-12 md:pb-16">
          <p className="text-sm text-muted-foreground mb-6">
            The open control plane for Harness Operations
          </p>
          <h1
            id="hero-title"
            className="text-5xl md:text-7xl font-medium tracking-tight leading-[1.05] max-w-4xl"
          >
            A harness for
            <br />
            your harness.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground leading-relaxed max-w-2xl mt-6">
            Operate agent teams across the harnesses and machines you already use. Choose the work,
            govern its execution, and review the evidence before deciding what ships.
          </p>
          <div className="flex flex-wrap items-center gap-5 mt-8">
            <Link
              to="/docs"
              className="inline-flex items-center gap-3 bg-foreground text-background px-5 py-3 rounded-md font-medium focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              Start from source <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link to="/docs/$" params={FIRST_TEAM_PARAMS} className={TEXT_LINK}>
              Run your first Team
            </Link>
          </div>
          <p className="text-sm text-muted-foreground mt-5">
            <Link to="/docs" hash="distribution-and-compatibility" className={TEXT_LINK}>
              Distribution and compatibility
            </Link>
          </p>
        </section>

        {/* Unedited screenshot from the real Electron #135 proof, published in PR #152.
            Captured 2026-09-07 against base 5c48b565f13735187faa9531de525692a4e840ca.
            Source: github-work-execution.real.spec.ts / completed-team-run.png. */}
        <figure>
          <a
            href="/cc/team-run-electron.png"
            aria-label="Open the Team Run screenshot at full size"
            className="block rounded-md border border-border overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <img
              src="/cc/team-run-electron.png"
              width={1440}
              height={1000}
              alt="A Consolidated Compute Team Run showing completed supervision, three completed Work Items, and retained worker activity."
              className="block w-full h-auto"
            />
          </a>
          <figcaption className="text-sm text-muted-foreground flex flex-wrap justify-between gap-2 mt-4">
            <span>Recorded Team Run · Electron on macOS · September 7, 2026</span>
            <Link to="/docs/$" params={CAPABILITIES_PARAMS} className={TEXT_LINK}>
              Read the evidence and limits
            </Link>
          </figcaption>
        </figure>

        <section aria-labelledby="workflow-title" className="py-16 md:py-24">
          <h2 id="workflow-title" className="text-3xl font-medium tracking-tight">
            From work to a reviewable result.
          </h2>
          <ol className="grid md:grid-cols-3 gap-8 mt-10">
            <li className="border-t border-border pt-5">
              <p className="text-sm text-muted-foreground mb-4" aria-hidden="true">
                01
              </p>
              <h3 className="text-lg font-medium">Choose the work</h3>
              <p className="text-muted-foreground leading-relaxed mt-3">
                Browse GitHub work on your host. Give an Assignment a clear objective while the
                source issue stays in GitHub.
              </p>
            </li>
            <li className="border-t border-border pt-5">
              <p className="text-sm text-muted-foreground mb-4" aria-hidden="true">
                02
              </p>
              <h3 className="text-lg font-medium">Govern a Team</h3>
              <p className="text-muted-foreground leading-relaxed mt-3">
                Use saved Agent Profiles, select a worktree Workspace, and inspect the security
                preview before starting. Respond when supervision needs you.
              </p>
            </li>
            <li className="border-t border-border pt-5">
              <p className="text-sm text-muted-foreground mb-4" aria-hidden="true">
                03
              </p>
              <h3 className="text-lg font-medium">Review the result</h3>
              <p className="text-muted-foreground leading-relaxed mt-3">
                Follow immutable Artifacts back to their producing agents. Inspect changes, tests,
                and the PR. Keep merge approval with a human.
              </p>
            </li>
          </ol>
        </section>

        <section
          aria-labelledby="runtime-title"
          className="border-t border-border py-12 grid md:grid-cols-2 gap-8 md:gap-16"
        >
          <div>
            <h2 id="runtime-title" className="text-3xl font-medium tracking-tight">
              Your harnesses.
              <br />
              Your hosts.
            </h2>
            <p className="mt-5 text-muted-foreground leading-relaxed">
              CC builds on Paseo&apos;s agent runtime. It adds a work and governance layer without
              replacing the coding agents you use.
            </p>
          </div>
          <div className="space-y-5 text-muted-foreground leading-relaxed">
            <p>
              Interactive GitHub Work uses the daemon host&apos;s authenticated <code>gh</code>. Hub
              is optional for later automation and hosted needs.
            </p>
            <p>
              Provider controls differ. Use the{" "}
              <Link to="/docs/$" params={CAPABILITIES_PARAMS} className={TEXT_LINK}>
                capability and evidence matrix
              </Link>{" "}
              to distinguish provider controls from recorded provider and platform proof.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8 flex flex-wrap justify-between gap-4 text-sm text-muted-foreground">
        <p>
          Built on{" "}
          <a href="https://github.com/getpaseo/paseo" className={TEXT_LINK}>
            Paseo
          </a>
          , created by Mohamed Boudra and contributors.
        </p>
        <a href={`${CC_REPOSITORY_URL}/blob/main/LICENSE`} className={TEXT_LINK}>
          Apache-2.0 license
        </a>
      </footer>
    </div>
  );
}
