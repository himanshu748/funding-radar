# Live research setup

Funding Radar opens saved research by default. Browsing the three original profiles and the recorded **Security & compliance** investigation, inspecting evidence, downloading saved JSON/CSV and preparing a local plan need no TinyFish key or credits. Live research is a separate, explicit action.

On **11 November 2026**, the separately authorized **one bounded $2 genuine test** completed with a **20-row ceiling and 19 returned rows**. The [live UI receipt](../evidence/readiness-final-2026-11-11/live-test.json) records the provider result and confirmed JSON/CSV exports. A [subsequent independent source review](../evidence/recorded-investigations/fresh-security-review.json) supports **17 recent comparable companies** and excludes two on workflow fit. The receipt's earlier “source review pending” state remains historical; the separate review supplies the later findings. No approach-ready investor shortlist is claimed for this recording.

The full **$2 reservation remains retained**. The client's **$1.90 row-count estimate is not an invoice or verified charge**. The new-bounty aggregate ceiling remains **$16**, and no further provider operation is authorized. Both live flags are now `0`, and the key/grant environment settings have been removed. Another live call requires the operator's own new, explicit authorization and valid controls; old exhausted or reserved grants must never be reused or reset.

## Open the saved preview

Use Node.js 22 or newer. These commands work from either the standalone package root or the shared bounty workspace root, meaning the directory that contains `package.json`, `shared/`, `providers/` and `funding-radar/`:

```sh
npm ci
FUNDING_RADAR_LIVE=0 BOUNTY_POOL_LIVE=0 node --import tsx funding-radar/src/server.ts
```

Open [http://127.0.0.1:4391](http://127.0.0.1:4391). Set `FUNDING_RADAR_PORT` to another port from 1024 to 65535 if needed. The server listens only on the local loopback interface.

Choose **Security & compliance** to inspect the completed investigation in the default preview. Its [exact saved export](../evidence/recorded-investigations/fresh-security-export.json) and separate company review are registered in the [recording catalogue](../evidence/recorded-investigations/catalog.json). The loader marks it `recorded_live`, preserves the original provider observations and transport, recomputes the report, and keeps the source review separate. Opening or exporting this recording starts no fresh research and consumes no provider allowance.

The [environment example](../../.env.example) is a reference. The server does not automatically load `.env` files. Environment values must be supplied explicitly through the shell or Node's `--env-file` option.

## Required live configuration

| Variable                    | Purpose                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FUNDING_RADAR_LIVE=1`      | Enables the application's explicit live session path.                                                                                   |
| `BOUNTY_POOL_LIVE=1`        | Enables the existing shared provider controls. Both live flags are required.                                                            |
| `FUNDING_RADAR_POLICY_ID`   | Selects an already authorized row policy in the grant.                                                                                  |
| `FUNDING_RADAR_TARGET_ROWS` | Exact requested company-row ceiling, an integer from 10 to 20. Defaults to 20 for live sessions. Match it to the intended policy bound. |
| `BOUNTY_POOL_GRANT_FILE`    | Absolute path to the private owner authorization JSON.                                                                                  |
| `TINYFISH_KEY_FILE`         | Absolute path to the existing private credential file.                                                                                  |
| `FUNDING_RADAR_PORT`        | Optional local port; default 4391.                                                                                                      |

A grant records permission to use an existing allowance. It does not buy credits, change billing, enable auto-reload or replenish a ledger. The shared controls require an unexpired grant, an initialized and matching ledger, a matching key fingerprint, sufficient permitted allowance and fresh acceptable pricing before dispatch.

Keep the grant and credential files outside the repository, as regular owner-only files, such as mode `0600`. The state directory must be owner-only, such as `0700`, and must not be a symlink. The credential file must contain exactly one unquoted assignment of this form, with the owner's existing key in place of the placeholder:

```dotenv
TINYFISH_API_KEY=REPLACE_WITH_EXISTING_PRIVATE_KEY
```

`key_sha256` is the SHA-256 of the key value itself, excluding the assignment prefix and line ending. The separate grant fingerprint binds the whole approved grant to its ledger. Changing an initialized grant's identity or limits does not silently create more allowance; the binding check rejects disagreement.

## A safe one-run grant template

The following JSON matches the [grant contract](../../shared/contracts.ts). It illustrates **one operation, at most 20 rows, at $0.10 per row**, with a **$2 maximum reservation** and one active operation. One dollar equals 1,000,000 microdollars.

This template is deliberately unusable: its dates are expired, its private path is a placeholder, and its key fingerprint is all zeroes. The example UUID identifies only this example. It is not the owner's active grant and must not replace or reset any existing grant or ledger.

```json
{
  "version": 1,
  "provider": "tinyfish",
  "pool_id": "funding-radar-example-only",
  "grant_id": "b0637326-172c-4916-adc8-abc35f85f1b8",
  "authorized_at": "2026-11-01T00:00:00Z",
  "expires_at": "2026-11-02T00:00:00Z",
  "currency": "USD",
  "max_reserved_microusd": 2000000,
  "max_concurrent_operations": 1,
  "state_directory": "/absolute/private/funding-radar-example/state",
  "key_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "allowed_bounties": ["funding-radar"],
  "policies": [
    {
      "id": "funding-radar-one-run-20",
      "unit": "row",
      "max_units_per_operation": 20,
      "max_unit_price_microusd": 100000,
      "max_operations": 1,
      "max_active_operations": 1,
      "enforcement": {
        "mechanism": "fixed_request_contract",
        "source_url": "https://docs.tinyfish.ai/datasets/reference.md",
        "description": "One bounded TinySet dataset with target_rows at most 20, created with populate false, followed by one population request. No automatic retry or additional operation."
      }
    }
  ]
}
```

A real grant must encode the existing owner approval, use an appropriate unique identity and private state path, and match the existing key. A new path or edited number is not additional authorization. The old exhausted or reserved StudyWindow, shared-pool, Source Hunter and Funding Radar allowances remain unchanged.

Initialize only a genuinely new, owner-approved grant, explicitly acknowledging its exact UUID. From the same package/workspace root:

```sh
node --import tsx shared/cli.ts init --grant /absolute/private/funding-radar/grant.json --confirm-grant b0637326-172c-4916-adc8-abc35f85f1b8
node --import tsx shared/cli.ts status --grant /absolute/private/funding-radar/grant.json
```

The UUID above is the template value. For a real approved grant, replace it in the confirmation command with that grant's actual `grant_id`. Initialization writes the private ledger and one-time binding. It sends no provider request. It refuses to initialize over an existing binding or ledger and never resets a consumed allowance. Missing, corrupt or uncertain existing state must be reconciled; do not recreate it to obtain another attempt.

## Enable the authorized path

Only after new explicit authorization, a valid real grant, private key and bound ledger are ready may an operator start the server with live configuration. The command below documents setup; it does not authorize or execute another run:

```sh
FUNDING_RADAR_LIVE=1 \
BOUNTY_POOL_LIVE=1 \
FUNDING_RADAR_POLICY_ID=funding-radar-one-run-20 \
FUNDING_RADAR_TARGET_ROWS=20 \
BOUNTY_POOL_GRANT_FILE=/absolute/private/funding-radar/grant.json \
TINYFISH_KEY_FILE=/absolute/private/tinyfish-key.env \
node --import tsx funding-radar/src/server.ts
```

An owner-only environment file can hold the same values. Load it explicitly with `node --env-file=/absolute/private/funding-radar.env --import tsx funding-radar/src/server.ts`. Never commit that file. Enabling the server does not itself start a research job; the UI or local API must explicitly request one. An enabled UI is also not proof that its grant, key or provider request will succeed.

The current library checks fresh TinySet pricing and requires $0.10 per row before dispatch. The displayed 20-row estimate is $2, and the example policy reserves at most $2 for its single operation. A lower target is supported by the application, but its policy and reservation must be reviewed together. A reservation is not a confirmed provider charge or invoice.

## Run, inspect and export

1. Open **Prepare your own brief** and enter the product, stage and country in 15 to 1,000 characters. The full text is preserved; unrecognized structured fields remain unknown.
2. **Prepare research plan** stays local and spends nothing. When live configuration is enabled, the separate paid section displays the row ceiling and estimated cost.
3. Choose **Run paid research** to start one explicit TinySet investigation. The browser creates a request UUID once and polls that same local status URL. It never repeats the paid start automatically.
4. While running, use **Request cancellation** if needed. This asks the server to abort the local operation and let the library establish remote termination. It does not promise immediate remote cancellation or a refund.
5. If the browser loses status confirmation, it holds that request as uncertain. Use **Check this same run**. Do not create another request to work around an uncertain outcome.
6. On completion, open **View new investigation**, inspect the source claims and use the **JSON** or **CSV** controls to download the result.

The manager runs at most one local job at a time and retains at most 20 jobs in memory. Repeating a UUID with the identical full description returns its existing status; changing the description under that UUID conflicts. A failed UUID is never retried automatically. A cancellation request can race with successful completion; the completed result remains visible when completion wins. `REMOTE_STATE_UNCERTAIN` remains failed/uncertain and fences further work until the underlying state is resolved.

New results and job records are in server memory, not automatically saved as files. Restarting the server loses those local sessions. The browser retains its active request reference in tab storage to avoid an automatic repeat; a restored reference cannot recover a lost session unless a completed, integrity-checked recording was separately preserved and registered. The confirmed Security & compliance recording is registered this way and remains browsable after restart with live research disabled. This does not resume or repeat its provider job.

The shared ledger remains on disk and preserves its separate allowance, request and uncertainty checks. Export a completed result deliberately, and reconcile an uncertain provider outcome before any new start. Registering a recording is not permission to bypass a retained reservation or uncertainty fence.

## Local API contract

All routes use the same local host/origin checks as the preview. These are application routes, not direct TinyFish endpoints.

| Route                              | Behavior                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/plan`                   | Accepts `{ "description": "..." }`; creates a local plan with zero provider operations.                                                  |
| `POST /api/research`               | Accepts `{ "description": "...", "request_id": "UUID" }`; explicitly starts a bounded job when configured. Returns 202 with status URLs. |
| `GET /api/research/UUID`           | Reads the existing job's local status. It does not start another provider operation.                                                     |
| `POST /api/research/UUID/cancel`   | Requests cancellation of that same job and returns its current state.                                                                    |
| `GET /api/investigation/UUID`      | Reads a completed investigation or a registered recording; incomplete jobs have no result yet.                                           |
| `GET /api/investigation/UUID.json` | Downloads completed JSON, including original source metadata.                                                                            |
| `GET /api/investigation/UUID.csv`  | Downloads company rows with provenance and review fields.                                                                                |

Status reports distinguish `running`, `complete` and `failed`, with `cancellation_requested` when applicable. Completed JSON keeps `provider_result.observations`, `provider_result.report` and `provider_result.transport` alongside the parsed investigation. Errors expose approved code/message fields; private request bodies, keys and traces are withheld. Optional request diagnostics record stage, method, HTTP status and outcome only.

## Keep source review separate

A completed research job means the library returned a result. New provider findings start with independent source review pending, zero independently reviewed companies and no approach-ready investor upgrade. Inspect the underlying funding links before using the shortlist.

The saved profiles can additionally contain separately researched public-web companies and selected reviewed investor records. Their review dates, source kinds, cheque scopes, named-person role qualifications and fit limits remain separate from original provider claims. They do not automatically become review evidence for a new startup description. See the [evidence record](EVIDENCE.md) and [judge guide](JUDGE_GUIDE.md).

The genuine test above supplies its own dated provider and browser receipt. Injected tests, enabled controls, local plans and later replays remain separate evidence; none counts as another live execution. The saved recording has a company-level source review, while its investor candidates remain unverified. It does not establish the same result for every new description or make another paid attempt permissible.
