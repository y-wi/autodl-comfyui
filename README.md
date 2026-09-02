# autodl-comfyui

Cursor **Agent Plugin** (not a Cursor IDE plugin) that wraps the [AutoDL.art ComfyUI HTTP API](https://autodl.art/docs/comfyui_api/). It exposes MCP tools so an agent can list workflows, load a workflow’s `input_rules`, submit a job, and poll results.

## Layout

```
plugin.json
mcp.json
server.mjs          # zero-dep Node 20 stdio MCP server
skills/autodl-comfyui-job/SKILL.md
```

## Tools

| Tool | Purpose |
| --- | --- |
| `list_workflows` | `POST /api/v1/comfyui/workflows` with `{ page_index, page_size }` (defaults 1 / 100, max 100). Pages automatically if `result_total` > `page_size` (cap 20 pages). Returns `{ total, workflows: [{ uuid, name, price_type, usage_count_7d }] }`. |
| `get_workflow` | `GET /api/v1/comfyui/workflows/{workflow_id}` → `ComfyUiWorkflow` |
| `submit_job` | `POST /api/v1/comfyui/comfyui_workflow/{workflow_id}` with the `inputs` object as the JSON body → `ComfyUiJob` |
| `get_job` | `GET /api/v1/comfyui/comfyui_workflow/result/{task_id}` → `ComfyUiJob` |

Call `list_workflows` when the user wants every workflow or does not know the id. Then `get_workflow(uuid)` for `input_rules`. `inputs` keys **must** come from that workflow’s `input_rules`. The tools do not hardcode MiniMax field names or a static catalog of ids. There is no blocking wait tool; poll `get_job` (jobs can take ~15 minutes). Result URLs expire quickly — download on `SUCCESS`.

## AUTODL_TOKEN

Create a **ComfyUI** group token at autodl.art 令牌管理. Set it in the environment as `AUTODL_TOKEN`. `mcp.json` passes `${AUTODL_TOKEN}` into the stdio server.

- Do not paste the token into chat.
- Do not put a real token in this repo, in `plugin.json`, or in prove notes.
- The HTTP `Authorization` header is the token as-is (no `Bearer` prefix).

## Local install (Cursor IDE)

Copy this directory to a real folder (not a symlink out of tree):

```
~/.cursor/plugins/local/autodl-comfyui
```

Then set `AUTODL_TOKEN` in the host environment Cursor uses for MCP. Grok Bot does not load plugins from `~/.cursor/plugins/local`; that path is for Cursor IDE.

## Prove locally

1. Validate `plugin.json` and `mcp.json` with the Agent Plugins 1.0.0 JSON Schemas (`additionalProperties` is false).
2. `node --check server.mjs`
3. Stdio smoke (token only in process env, never printed): `initialize` → `notifications/initialized` → `tools/list` (must include `list_workflows`) → `tools/call` `list_workflows` (assert `total >= 12` and director default uuid is in the list) → `tools/call` `get_workflow` for `minimax_h3_image_audio_to_video_v2_15s`, `minimax_h3_lightx2v_no_pic`, and `indextts2-v1` (each returns `uuid` + `input_rules` object). **Do not** call `submit_job` (it costs credits).
4. See `PROVE.md` for the last local run.

## Data shapes

```
ComfyUiWorkflowList = { total, workflows: [{ uuid, name, price_type, usage_count_7d }] }
ComfyUiWorkflow      = { uuid, name, input_rules, input_example }
ComfyUiJob           = { task_id, workflow_id, status, duration, results: [{ url, type, file_type }], inputs }
status               = QUEUED | RUNNING | SUCCESS | FAILED
```
