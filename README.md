# retrospective-builder

## Overview

The **Retrospective Builder** automates creation of Retrospective documents in Google Docs from Jira data, for Agile Product Managers and Development Leads.

### What It Does

- Fetches Jira issues for an epic
- Builds a timeline for executives
- Computes team insights (cycle time and throughput)
- Generates retrospective talking points:
  - ✅ What went well (<= 5 day cycle time)
  - ⚠️ What didn't go as planned (>5 day cycle time)
  - 🔁 What to try differently next time
- Writes everything into a formatted Google Doc in a shared Drive folder
- Stores generated document links in Google Cloud Storage
- Optional: Sends Slack notifications when docs are created

------------------------------------------------------------------------

## Tech Stack

- Node.js (ESM) + TypeScript
- Express (with web UI)
- Jira REST API
- Google Docs + Drive API (via service account)
- Google OAuth2 (browser login via googleapis)
- Google Cloud Secret Manager
- Google Cloud Storage
- Google Cloud Run
- Slack Webhooks (optional)
- Chart.js (analytics)

------------------------------------------------------------------------

## Authentication

The app uses **Google OAuth2** for browser access. When a user visits the app, they are redirected to a Google login prompt. After signing in, their email is checked against an allowlist stored in Secret Manager (`retrospective-allowed-emails`). Only listed emails are granted access.

Sessions are maintained via a signed cookie (7-day expiry).

> **Note for developers:** The session cookie uses `secure: false` intentionally. Cloud Run terminates TLS at the load balancer, so the app sees plain HTTP internally — `secure: true` would prevent the cookie from being set. The connection is still encrypted end-to-end from the user's perspective.

The `/health` endpoint is exempt from authentication so Cloud Run can probe it freely.

### Adding or Removing Users

Use `scripts/allowlist.sh`:

```bash
./scripts/allowlist.sh list                          # who has access today
./scripts/allowlist.sh add --dry-run jan@codev.com   # preview the change
./scripts/allowlist.sh add jan@codev.com miguel@codev.com
./scripts/allowlist.sh remove someone@codev.com
./scripts/allowlist.sh redeploy                      # apply the change immediately
```

The script reads the current list, writes it back with your change, and verifies the
result. Run `./scripts/allowlist.sh --help` for all options.

**Why a script rather than a one-line `gcloud` command:** the allowlist lives in the
`retrospective-allowed-emails` secret as one comma-separated string, and a new secret
version **replaces** the whole value — it does not append. Writing just the new address
would silently revoke everyone else's access. The script always reads the current value
first, and uses `printf` rather than `echo`, since a trailing newline would end up inside
the last email address.

Changes take effect on the next container startup. `redeploy` forces it immediately by
redeploying the image the service is already running — a restart, not a code change.
Images are tagged by commit SHA (see `cloudbuild.yaml`); there is no `:latest` tag, which
is why the script looks the image reference up rather than hardcoding it.

If you would rather run the steps by hand, `scripts/allowlist.sh` is short and the
`gcloud` invocations in it are the canonical ones.

#### Permissions required

The script needs these roles. Project **Owner** or **Editor** covers all of them — which
is why it works for whoever set the project up, and why it is easy to hand a teammate a
subset that only half works.

| To run | You need | Grant on |
| --- | --- | --- |
| `list` (and the read half of `add`/`remove`) | `roles/secretmanager.secretAccessor` | the secret |
| `add`, `remove` (writing a new version) | `roles/secretmanager.secretVersionAdder` | the secret |
| `versions` | `roles/secretmanager.viewer` | the secret |
| `redeploy` | `roles/run.developer` | the project |
| `redeploy` | `roles/iam.serviceAccountUser` | the runtime service account |

`secretAccessor` grants only `secretmanager.versions.access` — it does **not** allow
writing a new version or even listing versions. Someone with just that role can run
`list` and nothing else, so grant `secretVersionAdder` alongside it for anyone who
manages access.

`redeploy` needs `iam.serviceAccountUser` because deploying a Cloud Run service that runs
as a service account requires permission to *act as* that account. The service runs as
`959872421018-compute@developer.gserviceaccount.com`.

To grant someone the ability to manage the allowlist (scoped to the one secret, not the
whole project):

```bash
PERSON="user:person@curiouslearning.org"

for ROLE in roles/secretmanager.secretAccessor \
            roles/secretmanager.secretVersionAdder \
            roles/secretmanager.viewer; do
  gcloud secrets add-iam-policy-binding retrospective-allowed-emails \
    --project=gdl-reader-dev --member="$PERSON" --role="$ROLE"
done
```

And to let them redeploy as well:

```bash
gcloud projects add-iam-policy-binding gdl-reader-dev \
  --member="$PERSON" --role=roles/run.developer

gcloud iam service-accounts add-iam-policy-binding \
  959872421018-compute@developer.gserviceaccount.com \
  --project=gdl-reader-dev --member="$PERSON" --role=roles/iam.serviceAccountUser
```

To check what you have, just run `./scripts/allowlist.sh list` — it names the missing role
when a call is denied.

------------------------------------------------------------------------

## Developer Setup

### 1. Install Node.js

Download and install Node.js 20+ from https://nodejs.org

### 2. Install the gcloud CLI

Download and install from https://cloud.google.com/sdk/docs/install, then initialize:

```bash
gcloud init
```

Sign in with your Google account when prompted and select project `gdl-reader-dev` (option 33 in the project list).

### 3. Request GCP Access

Ask a project admin to grant your Google account access to `gdl-reader-dev`:

```bash
# Admin runs this — replace with the new dev's email
gcloud projects add-iam-policy-binding gdl-reader-dev \
  --member="user:devname@example.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 4. Authenticate Locally

Required once per machine so the app can read secrets from Secret Manager:

```bash
gcloud auth application-default login
```

### 5. Clone and Run

```bash
git clone https://github.com/curiouslearning/retrospective-builder.git
cd retrospective-builder
npm install
npm run dev
```

Navigate to `http://localhost:8080` — you will be prompted to sign in with Google.

### Local OAuth Login (Optional)

If you want the Google login flow to work locally, add `http://localhost:8080/auth/callback` as an authorized redirect URI in **GCP Console → APIs & Services → Credentials → OAuth 2.0 Client ID**. Without this, the app will still work if you hit the API endpoints directly, but visiting the UI will redirect you to Google and fail the callback.

------------------------------------------------------------------------

## Web UI

- Select a Jira project to load its ongoing epics
- View progress bars and existing retrospective links
- Generate a retrospective doc with one click
- Click **Analytics** for cycle time trends and throughput metrics

### API

```bash
curl -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{"board_name":"assessment js","epic_key":"AJ-581"}'
```

------------------------------------------------------------------------

## GCP Infrastructure

All secrets and infrastructure live in the `gdl-reader-dev` GCP project.

### Secrets (Google Cloud Secret Manager)

| Secret Name | Description |
|---|---|
| `retrospective-service-account` | Service account JSON for Google Docs/Drive |
| `retrospective-jira-token` | Atlassian API token |
| `retrospective-jira-base-url` | e.g. `https://your-org.atlassian.net` |
| `retrospective-jira-email` | Email of the Jira user the token belongs to |
| `retrospective-drive-folder-id` | Google Drive folder ID for generated docs |
| `retrospective-drive-user` | Workspace user the service account impersonates for Docs/Drive |
| `retrospective-storage-bucket` | GCS bucket name for storing document links |
| `retrospective-slack-webhook` | Slack webhook URL (optional) |
| `retrospective-oauth-client-id` | Google OAuth2 client ID for browser login |
| `retrospective-oauth-client-secret` | Google OAuth2 client secret for browser login |
| `retrospective-session-secret` | Random string used to sign session cookies |
| `retrospective-allowed-emails` | Comma-separated list of emails permitted to access the app |

To update a secret:
```bash
echo -n 'new-value' | gcloud secrets versions add SECRET_NAME \
  --project=gdl-reader-dev --data-file=-
```

### Service Account

`devops@gdl-reader-dev.iam.gserviceaccount.com`

### Google Drive

Generated docs are placed in:
`https://drive.google.com/drive/folders/16KKP1VoD1gOfEjQ3I1zM8A351LaDY_gs`

The service account must have **Editor** access to this folder.

------------------------------------------------------------------------

## Deployment

Deployment is automated via Cloud Build. Any push to `main` triggers a build and deploy to Cloud Run.

To deploy manually:

```bash
gcloud run deploy retrospective-builder \
  --image=us-east1-docker.pkg.dev/gdl-reader-dev/gdl-reader/retrospective-builder:COMMIT_SHA \
  --region=us-east1 \
  --platform=managed \
  --allow-unauthenticated \
  --project=gdl-reader-dev
```

Replace `COMMIT_SHA` with the commit you want to deploy — `cloudbuild.yaml` tags images by
commit SHA and never publishes a `:latest` tag. To list what has been built:

```bash
gcloud artifacts docker tags list \
  us-east1-docker.pkg.dev/gdl-reader-dev/gdl-reader/retrospective-builder \
  --project=gdl-reader-dev
```

------------------------------------------------------------------------

## Slack Integration (Optional)

1. Go to https://api.slack.com/apps → Create New App → From scratch
2. Go to Incoming Webhooks → Toggle ON → Add New Webhook → select a channel
3. Add the webhook URL to the `retrospective-slack-webhook` secret
