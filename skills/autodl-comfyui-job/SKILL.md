---
name: autodl-comfyui-job
description: Use when listing AutoDL.art ComfyUI workflows, or when submitting, polling, or reading a workflow job (get input_rules, submit a job, poll status, or fetch result URLs).
---

# AutoDL.art ComfyUI jobs

Use the `autodl-comfyui` MCP tools. Do not guess request bodies. Do not invent API fields.

## Tools

- `list_workflows` — load `{ total, workflows: [{ uuid, name, price_type, usage_count_7d }] }`. Source of truth for ids and names. Optional `page_index` (default 1) and `page_size` (default 100, max 100).
- `get_workflow` — load `ComfyUiWorkflow` (`uuid`, `name`, `input_rules`, `input_example`)
- `submit_job` — POST `inputs` as the JSON body; returns `ComfyUiJob` with `task_id` and `status`
- `get_job` — read `ComfyUiJob` (`status`, `duration`, `results`)

There is no blocking wait tool. Jobs can take many minutes; poll `get_job` yourself.

## Discover then submit

1. If the user wants all workflows, or does not know the id, call `list_workflows`. Use the returned `uuid` values. Do not invent ids and do not treat a remembered catalog as the API.
2. Call `get_workflow` with that `uuid` (as `workflow_id`).
3. Copy `input_rules` keys into `inputs`. Never invent body keys. Never add extra fields.
4. Call `submit_job` with `{ workflow_id, inputs }`. The server POSTs `inputs` as-is (not wrapped).
5. Poll `get_job` with the returned `task_id` about every 4 seconds until `status` is `SUCCESS` or `FAILED`.
6. On `SUCCESS`, download each `results[].url` immediately. URLs have a short TTL. Retry a failed download once.

`status` is `QUEUED` | `RUNNING` | `SUCCESS` | `FAILED`. Treat API `completed` as success only if the tool already mapped it to `SUCCESS`.

## Default workflow (director)

Default `workflow_id` used by the director: `minimax_h3_image_audio_to_video_v2_15s` (H3 multi-image/audio to video, 1–15s). Confirm it via `list_workflows` when listing; always fetch `input_rules` for the chosen uuid before submit. Do not hardcode a field list or a full catalog of ids as if it were the API.

## Auth

Token is `AUTODL_TOKEN` in the MCP server environment (ComfyUI group token from autodl.art 令牌管理). Never paste the token into chat.

## Docs

https://autodl.art/docs/comfyui_api/
