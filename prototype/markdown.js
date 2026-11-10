/* 赛博伙伴 · 轻量 Markdown 渲染（标题、列表、表格、引用、链接、代码块高亮） */
window.MD = (function () {
  'use strict';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[(\d{1,2})\]/g, '<sup class="cite">$1</sup>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
    return s;
  }

  const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  function table(rows) {
    const head = cells(rows[0]);
    let body = rows.slice(1);
    if (body.length && /^[\s|:-]+$/.test(body[0])) body = body.slice(1);
    return `<div class="tbl"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
      body.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  const BLOCK_START = /^(#{1,4}\s|\s*>|\s*\|.*\|\s*$|\s*[-*]\s+|\s*\d+[.)]\s+)/;
  function blocks(text) {
    const lines = text.split('\n');
    let html = '', i = 0, m;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
        const h = Math.min(6, m[1].length + 2);
        html += `<h${h}>${inline(m[2])}</h${h}>`; i++; continue;
      }
      if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += `<blockquote>${buf.map(inline).join('<br>')}</blockquote>`; continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        html += table(rows); continue;
      }
      if (/^\s*[-*]\s+/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
        html += '<ul>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ul>'; continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
        html += '<ol>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ol>'; continue;
      }
      const buf = [l]; i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !BLOCK_START.test(lines[i])) { buf.push(lines[i]); i++; }
      html += `<p>${buf.map(inline).join('<br>')}</p>`;
    }
    return html;
  }

  const KW = 'const|let|var|function|return|if|else|for|while|import|from|export|class|new|def|async|await|true|false|null|undefined|None|True|False|in|of|this|try|catch|print|lambda';
  const RE_C = new RegExp(`(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KW})\\b`, 'g');
  const RE_HASH = new RegExp(`(#[^\\n]*)|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KW})\\b`, 'g');
  function highlight(code, lang) {
    const re = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml)$/i.test(lang) ? RE_HASH : RE_C;
    re.lastIndex = 0;
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k';
      out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
      last = re.lastIndex;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(code.slice(last));
  }

  function render(src) {
    const parts = String(src || '').split(/^```/m);
    let html = '';
    parts.forEach((p, idx) => {
      if (idx % 2 === 0) { html += blocks(p.replace(/^[^\n]*\n?/, idx === 0 ? m0 => m0 : '')); return; }
      const nl = p.indexOf('\n');
      const lang = (nl < 0 ? p : p.slice(0, nl)).trim();
      const code = nl < 0 ? '' : p.slice(nl + 1).replace(/\n$/, '');
      html += `<div class="code"><div class="code-head"><span>${esc(lang || 'code')}</span><button class="code-copy" data-a="code-copy">复制</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
    });
    return html;
  }

  return { render, esc };
})();
