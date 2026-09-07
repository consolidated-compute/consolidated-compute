import type { Doc } from "~/docs";
import { docsSourceUrl } from "~/docs-identity";

export function DocsSourceFooter({ doc }: { doc: Doc }) {
  const sourceUrl = docsSourceUrl(doc.sourcePath);

  return (
    <footer className="docs-source-footer">
      <a href={sourceUrl} target="_blank" rel="noreferrer">
        View this page on GitHub
      </a>
      <p>
        Built on <a href="https://github.com/getpaseo/paseo">Paseo</a>.
      </p>
    </footer>
  );
}
