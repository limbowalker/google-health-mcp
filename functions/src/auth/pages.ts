const STYLE = `
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #f6f7f9; color: #1f2328; margin: 0; }
  main { max-width: 560px; margin: 48px auto; background: #fff; border-radius: 12px; padding: 32px;
         box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 22px; margin: 0 0 16px; }
  .muted { color: #59636e; font-size: 14px; }
  .box { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  label { display: block; margin: 8px 0; cursor: pointer; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid #d1d9e0; background: #fff; cursor: pointer; }
  button.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
  code, pre { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { white-space: pre-wrap; word-break: break-all; background: #f6f8fa; padding: 12px; border-radius: 8px; }
`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

const ACCESS_CHOICES = `
  <label><input type="radio" name="access" value="read" checked> <strong>Read only</strong>
    <span class="muted">— activity, workouts, sleep, heart, body and nutrition data</span></label>
  <label><input type="radio" name="access" value="write"> <strong>Read and write</strong>
    <span class="muted">— also lets the agent log meals, water, weight, workouts and sleep,
    change unit settings, and delete entries it created</span></label>`;

export function consentPage(opts: {
  requestId: string;
  clientName: string;
  redirectHost: string;
  loopbackOnly: boolean;
}): string {
  // The MCP authorization spec asks for an extra warning when a client only has loopback
  // redirects, since any local process can listen on a port and claim to be that client.
  const loopbackWarning = opts.loopbackOnly
    ? `<p class="box"><strong>Local app.</strong> This client receives access through an address on this
computer. Continue only if you just started the connection from an agent running here, such as Claude Code.</p>`
    : "";
  return layout(
    "Connect Google Health",
    `<h1>Connect Google Health to an AI agent</h1>
<div class="box">
  <div><strong>${escapeHtml(opts.clientName.slice(0, 120))}</strong></div>
  <div class="muted">will receive access at <code>${escapeHtml(opts.redirectHost)}</code></div>
</div>
${loopbackWarning}
<p>Only continue if you started this connection from your own agent and you recognize the address above.</p>
<form method="post" action="/oauth/consent">
  <input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
  ${ACCESS_CHOICES}
  <p class="muted">Next, Google will ask you to confirm which Google Health data to share. You can
  revoke access at any time in your Google Account permissions.</p>
  <div class="actions">
    <button class="primary" type="submit" name="action" value="approve">Continue with Google</button>
    <button type="submit" name="action" value="deny">Cancel</button>
  </div>
</form>`,
  );
}

export function connectPage(): string {
  return layout(
    "Personal access token",
    `<h1>Create a personal access token</h1>
<p>Use this only for agents that can't sign in with OAuth. The token is sent as an
<code>Authorization: Bearer</code> header and is valid for 90 days.</p>
<form method="post" action="/connect">
  ${ACCESS_CHOICES}
  <div class="actions"><button class="primary" type="submit">Sign in with Google</button></div>
</form>`,
  );
}

export function personalTokenPage(opts: { token: string; mcpUrl: string; expiresAt: Date }): string {
  const header = `Authorization: Bearer ${opts.token}`;
  return layout(
    "Your access token",
    `<h1>Your personal access token</h1>
<p>Copy it now; it won't be shown again. Treat it like a password. It expires on
${escapeHtml(opts.expiresAt.toISOString().slice(0, 10))}.</p>
<pre>${escapeHtml(opts.token)}</pre>
<p>MCP server URL:</p><pre>${escapeHtml(opts.mcpUrl)}</pre>
<p>HTTP header:</p><pre>${escapeHtml(header)}</pre>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function landingPage(mcpUrl: string): string {
  return layout(
    "Google Health MCP",
    `<h1>Google Health MCP server</h1>
<p>This server lets your AI agent read your Google Health data (including data synced from
Apple Health) and, if you allow it, log meals, weight and workouts.</p>
<p>Add this URL to your agent as a remote (Streamable HTTP) MCP server:</p>
<pre>${escapeHtml(mcpUrl)}</pre>
<p class="muted">Your agent will open a browser window to sign in with Google. Agents without OAuth
support can use a <a href="/connect">personal access token</a>.</p>`,
  );
}
