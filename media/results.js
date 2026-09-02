// Database Hub results grid — vanilla JS, renders one page at a time so
// even maxRows-sized result sets stay instant.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let data = null; // { meta, pageSize, messages, resultSets }
  let activeSet = 0;
  // Per result set view state: { sort: {col, dir}|null, filter, page, selected:Set, activeCell }
  let views = [];

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'running') {
      renderShell(msg.meta, `<div class="running"><span class="spinner"></span>Executing…</div>`);
    } else if (msg.type === 'error') {
      renderShell(msg.meta, `<div class="error">${esc(msg.message)}</div>`);
    } else if (msg.type === 'results') {
      data = msg;
      activeSet = 0;
      views = msg.resultSets.map(() => ({
        sort: null,
        filter: '',
        page: 0,
        selected: new Set(),
        activeCell: null,
      }));
      render();
    }
  });

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function band(meta, statsHtml) {
    return (
      `<div class="env-band" style="background:${esc(meta.envHex)}">` +
      `<span class="env-name">${esc(meta.environment)}${meta.readOnly ? ' · READ ONLY' : ''}</span>` +
      `<span class="conn">${esc(meta.connectionName)} — ${esc(meta.server)} / ${esc(meta.database)}</span>` +
      `<span class="stats">${statsHtml}</span></div>`
    );
  }

  function renderShell(meta, bodyHtml) {
    app.innerHTML = band(meta, '') + bodyHtml;
  }

  function totalRows() {
    return data.resultSets.reduce((n, rs) => n + rs.rows.length, 0);
  }

  function filteredSortedIndexes(rs, view) {
    let idx = rs.rows.map((_, i) => i);
    if (view.filter) {
      const f = view.filter.toLowerCase();
      idx = idx.filter((i) =>
        rs.rows[i].some((cell) => cell !== null && String(cell).toLowerCase().includes(f)),
      );
    }
    if (view.sort) {
      const { col, dir } = view.sort;
      idx.sort((a, b) => {
        const va = rs.rows[a][col];
        const vb = rs.rows[b][col];
        if (va === null && vb === null) return 0;
        if (va === null) return dir;
        if (vb === null) return -dir;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }
    return idx;
  }

  function render() {
    if (!data) return;
    const meta = data.meta;
    const rs = data.resultSets[activeSet];
    const stats =
      `${totalRows().toLocaleString()} rows · ${meta.durationMs} ms`;

    let html = band(meta, stats);

    if (data.resultSets.length > 1) {
      html += '<div class="tabs">';
      data.resultSets.forEach((set, i) => {
        html += `<button data-tab="${i}" class="${i === activeSet ? 'active' : ''}">Result ${i + 1} (${set.rows.length})</button>`;
      });
      html += '</div>';
    }

    if (!rs) {
      html += `<div class="empty">No result sets returned.</div>`;
      html += messagesHtml();
      app.innerHTML = html;
      wire();
      return;
    }

    const view = views[activeSet];
    const idx = filteredSortedIndexes(rs, view);
    const pageSize = data.pageSize || 1000;
    const pages = Math.max(1, Math.ceil(idx.length / pageSize));
    if (view.page >= pages) view.page = pages - 1;
    const pageIdx = idx.slice(view.page * pageSize, (view.page + 1) * pageSize);

    html +=
      '<div class="toolbar">' +
      `<input type="text" id="filter" placeholder="Filter rows…" value="${esc(view.filter)}">` +
      `<button id="copy-cell">Copy Cell</button>` +
      `<button id="copy-rows-csv">Copy Rows CSV</button>` +
      `<button id="copy-rows-json">Copy Rows JSON</button>` +
      `<button id="export-csv">Export CSV</button>` +
      `<button id="export-excel">Export Excel</button>` +
      '</div>';

    if (rs.truncated) {
      html += `<div class="truncated-note">⚠ Result truncated at ${rs.rows.length.toLocaleString()} rows — increase databaseHub.query.maxRows if needed.</div>`;
    }

    html += '<div class="grid-wrap"><table><thead><tr><th class="rownum">#</th>';
    rs.columns.forEach((col, c) => {
      let dir = '';
      if (view.sort && view.sort.col === c) {
        dir = `<span class="dir">${view.sort.dir === 1 ? '▲' : '▼'}</span>`;
      }
      html += `<th data-col="${c}" title="${esc(col)}">${esc(col)}${dir}</th>`;
    });
    html += '</tr></thead><tbody>';

    pageIdx.forEach((rowIdx) => {
      const selected = view.selected.has(rowIdx) ? ' class="selected"' : '';
      html += `<tr data-row="${rowIdx}"${selected}><td class="rownum">${rowIdx + 1}</td>`;
      rs.rows[rowIdx].forEach((cell, c) => {
        const isActive =
          view.activeCell && view.activeCell.row === rowIdx && view.activeCell.col === c;
        if (cell === null || cell === undefined) {
          html += `<td data-col="${c}" class="null${isActive ? ' cell-active' : ''}">NULL</td>`;
        } else {
          html += `<td data-col="${c}"${isActive ? ' class="cell-active"' : ''}>${esc(cell)}</td>`;
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';

    html +=
      '<div class="pager">' +
      `<button id="prev" ${view.page === 0 ? 'disabled' : ''}>‹ Prev</button>` +
      `<span>Page ${view.page + 1} / ${pages} — ${idx.length.toLocaleString()} row${idx.length === 1 ? '' : 's'}${view.filter ? ' (filtered)' : ''}</span>` +
      `<button id="next" ${view.page >= pages - 1 ? 'disabled' : ''}>Next ›</button>` +
      `<span>${view.selected.size ? view.selected.size + ' selected' : ''}</span>` +
      '</div>';

    html += messagesHtml();
    app.innerHTML = html;
    wire();
  }

  function messagesHtml() {
    if (!data.messages || data.messages.length === 0) return '';
    return `<div class="messages">${data.messages.map(esc).join('\n')}</div>`;
  }

  let lastClickedRow = null;

  function wire() {
    const rs = data.resultSets[activeSet];
    const view = views[activeSet];

    app.querySelectorAll('.tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        activeSet = Number(b.dataset.tab);
        render();
      });
    });

    const filter = document.getElementById('filter');
    if (filter) {
      let t = null;
      filter.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          view.filter = filter.value;
          view.page = 0;
          render();
          const f = document.getElementById('filter');
          f.focus();
          f.setSelectionRange(f.value.length, f.value.length);
        }, 200);
      });
    }

    app.querySelectorAll('th[data-col]').forEach((th) => {
      th.addEventListener('click', () => {
        const col = Number(th.dataset.col);
        if (view.sort && view.sort.col === col) {
          view.sort = view.sort.dir === 1 ? { col, dir: -1 } : null;
        } else {
          view.sort = { col, dir: 1 };
        }
        render();
      });
    });

    app.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        const rowIdx = Number(tr.dataset.row);
        const td = e.target.closest('td');
        if (td && td.dataset.col !== undefined) {
          view.activeCell = { row: rowIdx, col: Number(td.dataset.col) };
        }
        if (e.shiftKey && lastClickedRow !== null) {
          const idx = filteredSortedIndexes(rs, view);
          const a = idx.indexOf(lastClickedRow);
          const b = idx.indexOf(rowIdx);
          if (a !== -1 && b !== -1) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
              view.selected.add(idx[i]);
            }
          }
        } else if (e.ctrlKey || e.metaKey) {
          if (view.selected.has(rowIdx)) view.selected.delete(rowIdx);
          else view.selected.add(rowIdx);
        } else {
          view.selected = new Set([rowIdx]);
        }
        lastClickedRow = rowIdx;
        render();
      });
    });

    on('prev', () => {
      view.page--;
      render();
    });
    on('next', () => {
      view.page++;
      render();
    });
    on('copy-cell', () => {
      if (!view.activeCell) return;
      const v = rs.rows[view.activeCell.row][view.activeCell.col];
      copy(v === null || v === undefined ? 'NULL' : String(v));
    });
    on('copy-rows-csv', () => {
      const rows = selectedRows(rs, view);
      const lines = [rs.columns.map(csvField).join(',')].concat(
        rows.map((r) => r.map(csvField).join(',')),
      );
      copy(lines.join('\r\n'));
    });
    on('copy-rows-json', () => {
      const rows = selectedRows(rs, view);
      const objs = rows.map((r) => {
        const o = {};
        rs.columns.forEach((c, i) => {
          o[c] = r[i];
        });
        return o;
      });
      copy(JSON.stringify(objs, null, 2));
    });
    on('export-csv', () => vscode.postMessage({ type: 'export', format: 'csv', index: activeSet }));
    on('export-excel', () =>
      vscode.postMessage({ type: 'export', format: 'excel', index: activeSet }),
    );
  }

  function selectedRows(rs, view) {
    if (view.selected.size === 0) {
      return filteredSortedIndexes(rs, view).map((i) => rs.rows[i]);
    }
    return [...view.selected].sort((a, b) => a - b).map((i) => rs.rows[i]);
  }

  function csvField(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function copy(text) {
    vscode.postMessage({ type: 'copy', text });
  }

  function on(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  // Panel views resolve lazily; the host buffers the latest state message
  // until this handshake arrives, then replays it.
  vscode.postMessage({ type: 'ready' });
})();
