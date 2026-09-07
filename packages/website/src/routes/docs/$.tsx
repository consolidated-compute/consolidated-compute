import { createFileRoute } from "@tanstack/react-router";
import { DocsMarkdown } from "~/components/docs-markdown";
import { DocsMarkdownActions } from "~/components/docs-markdown-actions";
import { DocsSourceFooter } from "~/components/docs-source-footer";
import { getDoc } from "~/docs";
import { docsPageMeta } from "~/docs-identity";

export const Route = createFileRoute("/docs/$")({
  head: ({ params }) => {
    const slug = params._splat ?? "";
    const doc = getDoc(slug);
    if (!doc) return docsPageMeta("Not found", "Doc not found.");
    return docsPageMeta(doc.frontmatter.title, doc.frontmatter.description);
  },
  component: DocsPage,
});

function DocsPage() {
  const { _splat } = Route.useParams();
  const slug = _splat ?? "";
  return <RenderedDoc slug={slug} />;
}

function RenderedDoc({ slug }: { slug: string }) {
  const doc = getDoc(slug);

  if (!doc) {
    return <p className="text-muted-foreground">Doc not found.</p>;
  }

  return (
    <>
      <DocsMarkdownActions content={doc.content} markdownHref={`/docs/${slug}.md`} />
      <DocsMarkdown>{doc.content}</DocsMarkdown>
      <DocsSourceFooter doc={doc} />
    </>
  );
}
