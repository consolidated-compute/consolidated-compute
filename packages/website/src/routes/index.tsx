import { createFileRoute } from "@tanstack/react-router";
import { CcHome } from "~/components/cc-home";
import { ccPageMeta } from "~/site-identity";

export const Route = createFileRoute("/")({
  head: () =>
    ccPageMeta(
      "Consolidated Compute — A harness for your harness",
      "The open control plane for Harness Operations. Operate agent teams across the harnesses and machines you already use.",
    ),
  component: CcHome,
});
