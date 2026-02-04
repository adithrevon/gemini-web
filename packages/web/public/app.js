const statusEl = document.getElementById('status');
const messagesEl = document.getElementById('messages');
const composerEl = document.getElementById('composer');
const sendEl = document.getElementById('send');
const debug =
  window.location.search.includes('debug=1') ||
  window.localStorage.getItem('geminiWebDebug') === '1';
const log = (...args) => {
  if (debug) {
    console.log('[web-ui]', ...args);
  }
};

const state = {
  connected: false,
  cliConnected: false,
  history: [],
  pending: [],
  streamingState: 'idle',
  isTrustedFolder: false,
};

const escapeHtml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderAnsiOutput = (output) => {
  if (!Array.isArray(output)) return '';
  return output
    .map((line) =>
      Array.isArray(line)
        ? line.map((token) => token.text ?? '').join('')
        : '',
    )
    .join('\n');
};

const renderResultDisplay = (result) => {
  if (!result) return '';
  if (typeof result === 'string') {
    return `<pre class="tool-output">${escapeHtml(result)}</pre>`;
  }
  if (Array.isArray(result)) {
    const text = renderAnsiOutput(result);
    return `<pre class="tool-output">${escapeHtml(text)}</pre>`;
  }
  if (result.fileDiff) {
    return `<pre class="tool-output">${escapeHtml(result.fileDiff)}</pre>`;
  }
  if (result.todos) {
    const todos = result.todos
      .map(
        (todo) =>
          `<li><span class="todo-status">${escapeHtml(
            todo.status ?? 'pending',
          )}</span>${escapeHtml(todo.description ?? '')}</li>`,
      )
      .join('');
    return `<ul class="todo-list">${todos}</ul>`;
  }
  return `<pre class="tool-output">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
};

const sendConfirm = (callId, outcome, payload, correlationId) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log('confirm skipped (socket not open)');
    return;
  }
  log('send confirm', { callId, outcome, correlationId });
  socket.send(
    JSON.stringify({
      type: 'confirm',
      callId,
      outcome,
      payload,
      correlationId,
    }),
  );
};

const formatConfirmationDetails = (details) => {
  if (!details) return '';
  if (details.type === 'exec') {
    const command = details.command || details.rootCommand || '';
    return `<div class="confirm-details">
      <div class="confirm-title">${escapeHtml(details.title || 'Action Required')}</div>
      <div class="confirm-body">${escapeHtml(command)}</div>
    </div>`;
  }
  if (details.type === 'info') {
    return `<div class="confirm-details">
      <div class="confirm-title">${escapeHtml(details.title || 'Action Required')}</div>
      <div class="confirm-body">${escapeHtml(details.prompt || '')}</div>
    </div>`;
  }
  if (details.type === 'mcp') {
    return `<div class="confirm-details">
      <div class="confirm-title">${escapeHtml(details.title || 'Action Required')}</div>
      <div class="confirm-body">Tool: ${escapeHtml(details.toolDisplayName || details.toolName || '')}</div>
    </div>`;
  }
  return `<div class="confirm-details">
    <div class="confirm-title">Action Required</div>
  </div>`;
};

const renderConfirmationActions = (tool, isTrustedFolder) => {
  const options = [
    { label: 'Allow once', outcome: 'proceed_once', className: 'primary' },
  ];
  if (isTrustedFolder) {
    options.push({
      label: 'Allow for this session',
      outcome: 'proceed_always',
      className: 'secondary',
    });
  }
  options.push({
    label: 'No, suggest changes',
    outcome: 'cancel',
    className: 'ghost',
  });

  const correlationAttr = tool.correlationId
    ? ` data-correlation-id="${escapeHtml(tool.correlationId)}"`
    : '';

  const buttons = options
    .map(
      (option) =>
        `<button class="confirm-btn ${option.className}" data-call-id="${escapeHtml(
          tool.callId,
        )}" data-outcome="${option.outcome}"${correlationAttr}>${option.label}</button>`,
    )
    .join('');

  return `<div class="confirm-actions">${buttons}</div>`;
};

const renderToolGroup = (tools, pending) => {
  const confirmingTools = tools.filter(
    (tool) => String(tool.status).toLowerCase() === 'confirming',
  );

  const confirmationBlocks = confirmingTools
    .map(
      (tool) =>
        `<div class="confirm-block">
          ${formatConfirmationDetails(tool.confirmationDetails)}
          ${renderConfirmationActions(tool, state.isTrustedFolder)}
        </div>`,
    )
    .join('');

  const toolCards = tools
    .map((tool) => {
      const result = renderResultDisplay(tool.resultDisplay);
      return `
        <div class="tool-card">
          <div class="tool-header">
            <span class="tool-name">${escapeHtml(tool.name)}</span>
            <span class="tool-status status-${escapeHtml(
              String(tool.status ?? '').toLowerCase(),
            )}">${escapeHtml(tool.status ?? '')}</span>
          </div>
          <div class="tool-desc">${escapeHtml(tool.description ?? '')}</div>
          ${result}
        </div>
      `;
    })
    .join('');

  return `
    <div class="message tool-group ${pending ? 'pending' : ''}">
      <div class="bubble tool-bubble">
        <div class="tool-group-title">Tool calls</div>
        ${confirmationBlocks}
        ${toolCards}
      </div>
    </div>
  `;
};

const renderMessage = (item, pending) => {
  if (item.type === 'tool_group') {
    return renderToolGroup(item.tools ?? [], pending);
  }

  const role = item.type === 'user' ? 'user' : 'assistant';
  const text = item.text ? escapeHtml(item.text) : '';
  return `
    <div class="message ${role} ${pending ? 'pending' : ''}">
      <div class="bubble">
        ${text || '<span class="muted">(empty)</span>'}
      </div>
    </div>
  `;
};

const render = () => {
  const shouldStickToBottom =
    messagesEl.scrollTop + messagesEl.clientHeight >=
    messagesEl.scrollHeight - 48;

  const combined = [
    ...state.history.map((item) => ({ ...item, __pending: false })),
    ...state.pending.map((item) => ({ ...item, __pending: true })),
  ];

  messagesEl.innerHTML = combined
    .map((item) => renderMessage(item, item.__pending))
    .join('');

  if (state.streamingState === 'responding') {
    const indicator = document.createElement('div');
    indicator.className = 'typing';
    indicator.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(indicator);
  }

  if (shouldStickToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  messagesEl
    .querySelectorAll('.confirm-btn')
    .forEach((button) => {
      button.addEventListener('click', (event) => {
        const target = event.currentTarget;
        const callId = target?.getAttribute('data-call-id');
        const outcome = target?.getAttribute('data-outcome');
        const correlationId =
          target?.getAttribute('data-correlation-id') || undefined;
        if (!callId || !outcome) return;
        sendConfirm(callId, outcome, undefined, correlationId);
      });
    });
};

const updateStatus = () => {
  if (!state.connected) {
    statusEl.textContent = 'Connecting...';
    statusEl.className = 'status';
    return;
  }

  statusEl.textContent = state.cliConnected
    ? 'CLI connected'
    : 'Waiting for CLI...';
  statusEl.className = `status ${state.cliConnected ? 'ok' : 'warn'}`;
};

const sendSubmit = (text) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  log('send submit', text);
  socket.send(
    JSON.stringify({
      type: 'submit',
      text,
    }),
  );
};

const submit = () => {
  const raw = composerEl.value;
  if (!raw.trim()) return;
  log('submit', raw);
  sendSubmit(raw);
  composerEl.value = '';
};

sendEl.addEventListener('click', submit);
composerEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProtocol}://${window.location.host}/ws`;
let socket = null;

const connect = () => {
  socket = new WebSocket(wsUrl);
  log('connecting', wsUrl);

  socket.addEventListener('open', () => {
    log('open');
    state.connected = true;
    socket.send(JSON.stringify({ type: 'bridge:hello', role: 'web' }));
    updateStatus();
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'bridge:update') {
      log('bridge:update', message.payload);
      state.history = message.payload?.history ?? [];
      state.pending = message.payload?.pending ?? [];
      state.streamingState = message.payload?.streamingState ?? 'idle';
      state.isTrustedFolder = Boolean(message.payload?.isTrustedFolder);
      render();
    }

    if (message.type === 'bridge:cli-status') {
      log('cli-status', message.connected);
      state.cliConnected = Boolean(message.connected);
      updateStatus();
    }
  });

  socket.addEventListener('close', () => {
    log('close');
    state.connected = false;
    state.cliConnected = false;
    updateStatus();
    setTimeout(connect, 1000);
  });

  socket.addEventListener('error', (event) => {
    log('error', event);
  });
};

connect();
updateStatus();
