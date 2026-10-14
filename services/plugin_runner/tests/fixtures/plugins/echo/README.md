# Echo (test fixture)

The plugin platform's fixture plugin. Each action exercises one path of the runner
(success, timeout, crash, errors, noise on stdout, oversized results, isolation) or one
SDK call (`read_session`, `call_llm`, `propose_override`), and the manifest uses every
permission and extension point. It is used by the runner's tests and, as an archive, by
the webapp's install tests. It is not a real plugin and is never published in a catalog.
