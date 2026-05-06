# Production Deployment Runbook

This runbook describes the minimum reusable production deployment shape for MeetingAtlas.
It does not include secrets, host IPs, private keys, or real Feishu tokens.

## Latest RC Acceptance Snapshot

Snapshot for release candidate `6b9fb08`:

- Real LLM dry-run canary passed after `--dry-check`; all Feishu dry-run switches remained true, final summary reported `ok=true`, quality checks passed, and no real Feishu writes were performed.
- Real Feishu task, calendar, Wiki, and Doc canary passed in an isolated canary lane. This does not change the shared release default.
- Public server `/health` passed. Do not record the public hostname, tokens, or private deployment metadata in this runbook.
- Default release posture remains dry-run: `FEISHU_DRY_RUN=true` and `FEISHU_CARD_SEND_DRY_RUN=true`.
- Feishu meeting-minutes webhook public acceptance passed for `vc.meeting.recording_ready_v1`: a signed synthetic event returned `202`, the duplicate event returned `duplicate`, and the stored webhook event reached `processed`. Card-action public acceptance remains a separate check.

## Runtime Baseline

- Use Node.js 24 LTS or newer.
- Run the service behind Nginx with HTTPS.
- Keep the Node process bound to `127.0.0.1` by default when Nginx is on the same host.
- Set `HOST=0.0.0.0` only when the service must listen on all interfaces, such as a container or separated reverse-proxy topology.
- Store SQLite on a persistent directory that survives deploys and restarts.
- Keep `.env` owned by the deploy user and readable only by that user: `chmod 600 .env`.

## Minimal Environment

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
SQLITE_PATH=/var/lib/meetingatlas/meeting-atlas.db

FEISHU_DRY_RUN=true
FEISHU_CARD_SEND_DRY_RUN=true
FEISHU_CARD_ACTIONS_ENABLED=true
FEISHU_EVENT_CARD_CHAT_ID=

LARK_VERIFICATION_TOKEN=
LARK_ENCRYPT_KEY=
LARK_CARD_CALLBACK_URL_HINT=https://your-domain.example/webhooks/feishu/card-action
LARK_CLI_BIN=lark-cli

DEV_API_KEY=

LLM_PROVIDER=openai-compatible
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=60000
LLM_MAX_INPUT_CHARS=30000
LLM_TEMPERATURE=0
LLM_MAX_TOKENS=4096
LLM_DEBUG_RAW=false
```

`FEISHU_DRY_RUN=true` is the mature default for shared production-like releases. Do not treat
`FEISHU_DRY_RUN=false` as the default production posture. Real writes belong only in an isolated
canary with a dedicated database, dedicated Feishu workspace or recipients, and explicit rollback
expectations.

Mode B+ for production readiness should keep `FEISHU_DRY_RUN=true` and turn off only card-send
dry-run:

```env
FEISHU_DRY_RUN=true
FEISHU_CARD_SEND_DRY_RUN=false
```

This sends real confirmation cards while task, calendar, Wiki, and Doc writes remain dry-run.

## Build And Start

```bash
npm ci
npm run build
npm start
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

If `HOST=0.0.0.0` is required, keep the firewall and reverse proxy rules strict so the public
entrypoint is still HTTPS through Nginx.

## Systemd Service

Example unit:

```ini
[Unit]
Description=MeetingAtlas API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/meetingatlas
EnvironmentFile=/opt/meetingatlas/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=meetingatlas
Group=meetingatlas
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/meetingatlas /opt/meetingatlas

[Install]
WantedBy=multi-user.target
```

Operational commands:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meetingatlas
sudo systemctl status meetingatlas
journalctl -u meetingatlas -f
```

## Nginx HTTPS Reverse Proxy

Terminate TLS at Nginx and proxy to the local Node listener:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.example;

    ssl_certificate /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Firewall baseline:

```bash
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
sudo ufw status
```

Keep port `3000` private when the service binds to `127.0.0.1`. If a deployment uses `HOST=0.0.0.0`,
the firewall must still prevent direct public access to the Node port.

## Feishu Console Configuration

Configure the public HTTPS URLs in Feishu Open Platform:

- Event subscription request URL: `https://your-domain.example/webhooks/feishu/event`
- Card action request URL: `https://your-domain.example/webhooks/feishu/card-action`
- Verification Token: copy into `LARK_VERIFICATION_TOKEN`
- Encrypt Key: copy into `LARK_ENCRYPT_KEY`

Set `LARK_CARD_CALLBACK_URL_HINT` to the exact card action URL:

```env
LARK_CARD_CALLBACK_URL_HINT=https://your-domain.example/webhooks/feishu/card-action
```

Do not paste real tokens into this document, commit history, tickets, screenshots, or logs.

## Safety Modes

- Mode A, default safe mode: `FEISHU_DRY_RUN=true` and `FEISHU_CARD_SEND_DRY_RUN=true`.
- Mode B+, real card canary: `FEISHU_DRY_RUN=true` and `FEISHU_CARD_SEND_DRY_RUN=false`.
- Mode C, isolated real-write canary: only for dedicated environments; never as the default release mode.

Server reality today is systemd plus Nginx reverse proxy. The operational risk is assuming that a
working reverse proxy means real Feishu writes are safe. They are separate concerns: HTTPS and
webhook reachability prove delivery, not business-side write readiness. Keep real writes isolated
until each write path has been canaried with least-privilege Feishu credentials and a disposable
dataset.
