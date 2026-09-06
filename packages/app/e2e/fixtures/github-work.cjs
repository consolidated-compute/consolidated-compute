// External CLI adapter for the GitHub Work browser tests. The app, RPC, discovery
// service, and Assignment persistence remain real; no GitHub credentials are used.
module.exports = function runGitHubWorkFixture(args) {
  const host = args[args.indexOf("--hostname") + 1];
  const variables = Object.fromEntries(
    args
      .filter((arg) => arg.includes("="))
      .map((arg) => {
        const split = arg.indexOf("=");
        return [arg.slice(0, split), arg.slice(split + 1)];
      }),
  );
  const search = variables.searchQuery || "";
  if (args[0] === "auth") {
    if (host === "unauthenticated.test") {
      process.stderr.write("not logged into this host; gh auth login required");
      process.exit(1);
    }
    return true;
  }
  const repository = (id, name) => ({
    id,
    nameWithOwner: `fixture/${name}`,
    url: `https://${host}/fixture/${name}`,
    sshUrl: `git@${host}:fixture/${name}.git`,
    visibility: "PRIVATE",
    isArchived: false,
    updatedAt: "2026-09-05T00:00:00Z",
  });
  const first = repository("R_browser", "browser");
  const second = repository("R_other", "other");
  const page = (nodes, next = null) => ({
    nodes,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  });
  let data;
  if (variables.query.includes("node(id:")) {
    data = { node: variables.id === first.id ? first : second };
  } else if (variables.query.includes("type:ISSUE")) {
    if (search.includes("rate-limit")) {
      process.stderr.write("API rate limit exceeded");
      process.exit(1);
    }
    const pr = search.includes("is:pr");
    const closed = search.includes("is:closed");
    const id = pr ? "PR_browser" : "I_browser";
    const repo = search.includes("repo:fixture/other") ? second : first;
    const number = variables.cursor ? 2 : 1;
    const item = {
      __typename: pr ? "PullRequest" : "Issue",
      id: `${id}_${number}`,
      number,
      title: workTitle(pr, number),
      url: `${repo.url}/${pr ? "pull" : "issues"}/${number}`,
      state: closed ? "CLOSED" : "OPEN",
      body: "BODY_ONLY_SENTINEL\n" + "Bounded external description. ".repeat(1300),
      updatedAt: "2026-09-05T00:00:00Z",
      repository: { id: repo.id },
      labels: { nodes: [{ name: "feature" }] },
    };
    data = {
      search: page(
        search.includes("no-results") ? [] : [item],
        variables.cursor || pr ? null : "work-page-2",
      ),
    };
  } else {
    const result = page(
      variables.cursor ? [second] : [first],
      variables.cursor ? null : "repo-page-2",
    );
    data = variables.query.includes("viewer{")
      ? { viewer: { repositories: result } }
      : { search: result };
  }
  process.stdout.write(JSON.stringify({ data }));
  return true;
};

function workTitle(pr, number) {
  return pr ? "Review the browser" : `Browse without a Workspace ${number}`;
}
