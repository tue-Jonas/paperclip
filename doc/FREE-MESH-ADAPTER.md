# Free Mesh Adapter

`free-mesh` is a low-trust, OpenAI-compatible adapter for routing public,
low-stakes validation and research through a LiteLLM mesh.

Use `claude_local` or `codex_local` for master agents, coding agents,
high-stakes decisions, proprietary/customer data, regulated data, or any
secret-bearing work.

## Configuration

Agent `adapterType`: `free-mesh`

Required:

- `dataPolicy`: must be `low_stakes_public_only`
- `baseUrl` or `env.FREE_MESH_BASE_URL`: OpenAI-compatible API root; may end in `/v1`
- `apiKey` or `env.FREE_MESH_API_KEY`: LiteLLM/OpenAI-compatible API key

Optional:

- `model`: LiteLLM model name, defaults to `swarm-public`
- `env.FREE_MESH_MODEL`: model fallback when `model` is unset
- `temperature`: defaults to `0.2`
- `timeoutMs`: defaults to `60000`
- `promptTemplate`: custom prompt; otherwise Paperclip sends a compact task-context prompt

Prefer secret bindings for `env.FREE_MESH_API_KEY`; do not commit keys or put
real credentials in docs, tests, comments, or issue descriptions.

## Runtime Behavior

The adapter sends `POST {baseUrl}/chat/completions` with a standard
OpenAI-compatible `messages` payload. The response text is written to the run
log and summary.

The adapter intentionally does not expose a Paperclip local agent JWT to the
mesh. This keeps the mesh lane useful for low-stakes analysis while preserving
Claude/Codex as the trusted adapters that can mutate the control plane.
