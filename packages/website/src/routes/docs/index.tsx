import { createFileRoute } from "@tanstack/react-router";
import { DocsMarkdown } from "~/components/docs-markdown";
import { DocsMarkdownActions } from "~/components/docs-markdown-actions";
import { DocsSourceFooter } from "~/components/docs-source-footer";
import { getDoc } from "~/docs";
import { docsPageMeta } from "~/site-identity";

export const Route = createFileRoute("/docs/")({
  head: () => {
    const doc = getDoc("");
    if (!doc)
      return docsPageMeta("Documentation", "Set up Consolidated Compute and run your first Team.");
    return docsPageMeta(doc.frontmatter.title, doc.frontmatter.description);
  },
  component: DocsIndex,
});

function DocsIndex() {
  const doc = getDoc("");
  if (!doc) return <p className="text-muted-foreground">Doc not found.</p>;
  return (
    <>
      <DocsMarkdownActions content={doc.content} markdownHref="/docs.md" />
      <DocsMarkdown>{doc.content}</DocsMarkdown>
      <DocsSourceFooter doc={doc} />
    </>
  );
}
