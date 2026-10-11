(function () {
  'use strict';

  var E = window.Exporters;
  var STORAGE_KEY = 'laborMeetingProposalSystem.v1';

  var STATUS = ['草稿', '提案', '列管中', '結案'];
  var STATUS_COLOR = { '草稿': 'gray', '提案': 'blue', '列管中': 'orange', '結案': 'teal' };
  // 舊資料的狀態名稱對應到新流程
  var STATUS_MIGRATION = { '送審': '提案', '已決議': '列管中' };

  var state = {
    sessions: [],
    activeSessionId: null,
    activeProposalId: null,
    panel: 'proposal',
    inspectorOpen: false,
    view: 'list',
    query: '',
    statusFilter: 'all',
    theme: null,
    selection: {},
    pending: null,          // 正在建立、尚未加入清單的新提案
    pendingReturnId: null,  // 取消建立時要還原的選取
    pendingInvalid: false   // 送出時案由未填
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function options(list, selected) {
    return list.map(function (item) {
      return '<option value="' + esc(item) + '"' + (item === selected ? ' selected' : '') + '>' + esc(item) + '</option>';
    }).join('');
  }

  var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  function weekdayOf(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return '（' + WEEKDAYS[d.getDay()] + '）';
  }

  function sessionLabel(session) {
    return E.sessionLabel(session);
  }

  /* ── 資料存取 ─────────────────────────────────────────────── */

  function activeSession() {
    return state.sessions.find(function (s) { return s.id === state.activeSessionId; }) || null;
  }

  // 直接開啟本機檔案（尤其 iOS）時 localStorage 可能不可用，先偵測再提示使用者備份。
  var storageOK = (function () {
    try {
      var probe = '__lm_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (err) {
      return false;
    }
  })();

  function activeProposal() {
    var session = activeSession();
    if (!session) return null;
    return (session.proposals || []).find(function (p) { return p.id === state.activeProposalId; }) || null;
  }

  function findProposal(id) {
    var found = null;
    state.sessions.some(function (session) {
      var hit = (session.proposals || []).find(function (p) { return p.id === id; });
      if (hit) { found = { session: session, proposal: hit }; return true; }
      return false;
    });
    return found;
  }

  function sessionItems(session) {
    return (session && session.proposals || []).map(function (p) {
      return { session: session, proposal: p };
    });
  }

  // 空白提案：除了自動帶入的案號外，使用者什麼都沒填
  var BLANK_FIELDS = ['subject', 'description', 'method', 'resolution',
    'proposer', 'unit', 'dueDate'];

  // 舊狀態名稱（送審／已決議）對應到新的四個狀態
  function migrateData() {
    state.sessions.forEach(function (session) {
      (session.proposals || []).forEach(function (p) {
        if (STATUS_MIGRATION[p.status]) p.status = STATUS_MIGRATION[p.status];
        if (STATUS.indexOf(p.status) < 0) p.status = '草稿';
      });
    });
  }

  function isBlankProposal(p) {
    return !!p && BLANK_FIELDS.every(function (key) { return !String(p[key] || '').trim(); });
  }

  // 正在編輯的對象：新增中的 pending 提案優先，其次是清單中選取的提案
  function editingProposal() {
    return state.pending || activeProposal();
  }

  // 新提案要先填好才成立：案由有填就自動建立，沒填就丟掉，避免留下空卡片
  function settlePending() {
    if (!state.pending) return false;
    if (String(state.pending.subject || '').trim()) {
      commitPending(true);
    } else {
      state.pending = null;
      state.activeProposalId = state.pendingReturnId || state.activeProposalId;
      state.pendingReturnId = null;
      toast('已取消未填寫的新提案');
    }
    return true;
  }

  function commitPending(silent) {
    var session = activeSession();
    var proposal = state.pending;
    if (!session || !proposal) return false;
    if (!String(proposal.subject || '').trim()) {
      state.pendingInvalid = true;
      renderInspector();
      focusField('subject');
      toast('請先填寫案由');
      return false;
    }
    session.proposals = session.proposals || [];
    session.proposals.push(proposal);
    state.pending = null;
    state.pendingInvalid = false;
    state.pendingReturnId = null;
    state.activeProposalId = proposal.id;
    renderAll();
    revealProposal(proposal.id);
    if (!silent) toast('已新增提案');
    return true;
  }

  function cancelPending() {
    if (!state.pending) return;
    state.pending = null;
    state.pendingInvalid = false;
    state.activeProposalId = state.pendingReturnId || null;
    state.pendingReturnId = null;
    if (!activeProposal()) state.panel = 'session';
    renderAll();
    toast('已取消');
  }

  function pickedItems() {
    var items = [];
    state.sessions.forEach(function (session) {
      (session.proposals || []).forEach(function (p) {
        if (state.selection[p.id]) items.push({ session: session, proposal: p });
      });
    });
    return items;
  }

  function save() {
    if (!storageOK) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        theme: state.theme
      }));
    } catch (err) { /* 配額用盡等例外：仍可操作，只是不保留 */ }
  }

  function isNarrow() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 1000px)').matches);
  }

  function openInspector() {
    state.inspectorOpen = true;
    renderInspector();
    var panel = $('#inspector');
    if (isNarrow() && panel && panel.scrollIntoView) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // 把游標帶到指定欄位（新增提案時應該直接落在「案由」，而不是自動帶入的案號）
  function focusField(key) {
    var el = document.querySelector('#inspBody [data-k="' + key + '"]');
    if (el) el.focus();
  }

  // 新增或複製後，把新卡片捲進視野並短暫標示，避免使用者以為「按了沒反應」
  function revealProposal(id) {
    var body = $('#inspBody');
    if (body) body.scrollTop = 0;
    if (isNarrow()) return; // 手機由 openInspector 捲到表單，兩個捲動同時做會互相打架
    var row = document.querySelector('.prow[data-id="' + id + '"]');
    if (!row) return;
    if (row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('is-new');
    setTimeout(function () { row.classList.remove('is-new'); }, 1400);
  }

  function load() {
    var raw;
    if (!storageOK) return false;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (err) { return false; }
    if (!raw) return false;
    try {
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.sessions)) return false;
      state.sessions = data.sessions;
      state.activeSessionId = data.activeSessionId || (data.sessions[0] && data.sessions[0].id) || null;
      state.theme = (data.theme === 'dark' || data.theme === 'light') ? data.theme : null;
      var current = state.sessions.find(function (s) { return s.id === state.activeSessionId; });
      state.activeProposalId = current && current.proposals && current.proposals.length
        ? current.proposals[0].id : null;
      migrateData();
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ── 範例資料 ─────────────────────────────────────────────── */

  function seedData() {
    var s1 = {
      id: uid('s'), term: '第3屆', round: '第8次', date: '2026-09-18', time: '14:00',
      place: '總公司 7 樓會議室', chair: '陳建宏（資方代表）', recorder: '林雅婷',
      laborReps: '王小明、李佳蓉、張志豪', mgmtReps: '陳建宏、黃美玲、吳宗翰',
      note: '本次會議依《勞資會議實施辦法》規定召開。',
      proposals: [
        {
          id: uid('p'), no: '勞20260001',
          proposer: '王小明',
          subject: '建議調整輪班人員休息時間安排',
          description: '廠區輪班人員於夜班時段連續工作 4 小時，現行僅安排 30 分鐘休息，'
            + '多名同仁反映精神負荷較高。\n鄰近同業多已調整為每 2 小時休息 15 分鐘。\n'
            + '依《勞動基準法》第 35 條，繼續工作 4 小時應至少休息 30 分鐘。',
          method: '夜班時段改採每 2 小時休息 15 分鐘，合計休息時間維持 30 分鐘以上。\n'
            + '由人力資源部會同製造部於一個月內完成班表試算。\n'
            + '試辦三個月後於下次勞資會議報告執行情形。',
          resolution: '照案通過，自 115 年 10 月 1 日起試辦三個月。',
          unit: '人力資源部', dueDate: '2026-10-01', status: '結案'
        },
        {
          id: uid('p'), no: '勞20260002',
          proposer: '黃美玲',
          subject: '員工餐廳菜色與供餐時段改善',
          description: '部分同仁反映晚班用餐時段（18:30－19:00）供餐品項偏少。\n'
            + '建議增設一處取餐檯以分散人潮。',
          method: '請總務部評估增設取餐檯之可行性與費用。\n延期另議。',
          resolution: '請總務部於一個月內提出評估報告後續討論。',
          unit: '總務部', dueDate: '2026-10-20', status: '列管中'
        },
        {
          id: uid('p'), no: '勞20260003',
          proposer: '李佳蓉',
          subject: '加班費計算方式說明與補休期限調整',
          description: '同仁對休息日加班費之計算級距理解不一。\n'
            + '現行補休期限為 3 個月，部分同仁反映期限過短。',
          method: '請人力資源部製作加班費計算說明表並公告。\n'
            + '補休期限由 3 個月調整為 6 個月，並於勞動契約或工作規則中明定。',
          resolution: '',
          unit: '人力資源部', dueDate: '2026-11-30', status: '提案'
        }
      ]
    };
    var s2 = {
      id: uid('s'), term: '第3屆', round: '第9次', date: '2026-12-19', time: '14:00',
      place: '總公司 7 樓會議室', chair: '', recorder: '',
      laborReps: '', mgmtReps: '', note: '',
      proposals: [
        {
          id: uid('p'), no: '勞20260004',
          proposer: '人力資源部',
          subject: '第8次會議決議事項執行情形報告',
          description: '夜班休息時間調整案自 10 月 1 日起試辦，試辦期間無異常。',
          method: '報告事項，提請備查。',
          resolution: '', unit: '人力資源部', dueDate: '', status: '草稿'
        },
        {
          id: uid('p'), no: '勞20260005',
          proposer: '張志豪',
          subject: '年度員工健康檢查項目調整建議',
          description: '現行健檢方案未包含心血管相關進階項目。',
          method: '建議於次年度合約中納入頸動脈超音波與心電圖檢查。',
          resolution: '', unit: '人力資源部', dueDate: '2026-12-31', status: '草稿'
        }
      ]
    };
    state.sessions = [s1, s2];
    state.activeSessionId = s1.id;
    state.activeProposalId = s1.proposals[0].id;
  }

  /* ── 版面渲染 ─────────────────────────────────────────────── */

  function icons() {
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  function applyTheme() {
    var theme = state.theme;
    if (theme !== 'light' && theme !== 'dark') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  }

  function renderSessions() {
    var host = $('#sessionList');
    if (!state.sessions.length) {
      host.innerHTML = '<div class="empty" style="padding:26px 12px;"><p>尚無會議場次</p></div>';
      return;
    }
    host.innerHTML = state.sessions.map(function (session) {
      var count = (session.proposals || []).length;
      return '' +
        '<button class="session-item' + (session.id === state.activeSessionId ? ' is-on' : '') + '" data-id="' + session.id + '">' +
          '<span class="si-top"><span class="si-term">' + esc(sessionLabel(session)) + '</span>' +
            '<span class="si-count">' + count + '</span></span>' +
          '<span class="si-date">' + esc(E.slashDate(session.date) || '未設定日期') + weekdayOf(session.date) + '</span>' +
          '<span class="si-del" role="button" title="刪除場次" data-act="deleteSession" data-id="' + session.id + '"><i data-lucide="trash-2"></i></span>' +
        '</button>';
    }).join('');
    icons();
  }

  function renderHead() {
    var session = activeSession();
    if (!session) {
      $('#sessionTitle').textContent = '勞資會議提案';
      $('#sessionMeta').textContent = '請先建立會議場次';
      return;
    }
    var meta = [E.slashDate(session.date) + weekdayOf(session.date), session.time, session.place]
      .filter(Boolean).join('・');
    var people = [session.chair ? '主席 ' + session.chair : '', session.recorder ? '紀錄 ' + session.recorder : '']
      .filter(Boolean).join('・');
    $('#sessionTitle').textContent = sessionLabel(session);
    $('#sessionMeta').textContent = [(session.proposals || []).length + ' 件提案', meta, people]
      .filter(Boolean).join('・');
  }

  function visibleProposals() {
    var session = activeSession();
    if (!session) return [];
    var query = state.query.trim().toLowerCase();
    return (session.proposals || []).filter(function (p) {
      if (state.statusFilter !== 'all' && p.status !== state.statusFilter) return false;
      if (!query) return true;
      return [p.no, p.subject, p.proposer, p.description, p.method, p.resolution, p.unit]
        .some(function (field) { return String(field || '').toLowerCase().indexOf(query) >= 0; });
    });
  }

  function renderFilters() {
    var session = activeSession();
    var host = $('#filters');
    if (!session) { host.innerHTML = ''; return; }
    var list = session.proposals || [];
    var chips = [{ key: 'all', label: '全部', count: list.length }].concat(STATUS.map(function (status) {
      return {
        key: status,
        label: status,
        count: list.filter(function (p) { return p.status === status; }).length
      };
    }));
    host.innerHTML = chips.map(function (chip) {
      return '<button class="fchip' + (chip.key === state.statusFilter ? ' is-on' : '') + '" data-status="' + esc(chip.key) + '">' +
        esc(chip.label) + '<span class="n">' + chip.count + '</span></button>';
    }).join('');
  }

  function rowHTML(p) {
    var meta = [
      p.proposer ? '提案人 ' + p.proposer : '',
      p.unit ? '執行 ' + p.unit : '',
      p.dueDate ? '期限 ' + E.slashDate(p.dueDate) : ''
    ].filter(Boolean);
    var picked = !!state.selection[p.id];
    return '' +
      '<article class="prow' + (p.id === state.activeProposalId ? ' is-on' : '') + '" data-id="' + p.id + '" tabindex="0">' +
        '<button class="pick' + (picked ? ' is-on' : '') + '" data-act="pick" data-id="' + p.id + '" ' +
          'title="' + (picked ? '取消選取' : '選取以批次匯出提案單') + '" aria-pressed="' + (picked ? 'true' : 'false') + '" ' +
          'aria-label="選取提案 ' + esc(p.no || '') + '"><i data-lucide="check"></i></button>' +
        '<div class="prow-main">' +
          '<div class="prow-line1">' +
            '<span class="pno">' + esc(p.no || '未編號') + '</span>' +
            '<span class="badge ' + (STATUS_COLOR[p.status] || 'gray') + '">' + esc(p.status || '草稿') + '</span>' +
          '</div>' +
          '<div class="prow-subject">' + esc(p.subject || '（未填案由）') + '</div>' +
          '<div class="prow-meta">' + meta.map(function (item) { return '<span>' + esc(item) + '</span>'; }).join('') + '</div>' +
        '</div>' +
        '<div class="prow-actions">' +
          '<button class="icon-btn sm" title="複製提案" data-act="duplicate" data-id="' + p.id + '"><i data-lucide="copy"></i></button>' +
          '<button class="icon-btn sm" title="匯出這張提案單" data-act="wordOne" data-id="' + p.id + '"><i class="office-ico word" aria-hidden="true"></i></button>' +
        '</div>' +
      '</article>';
  }

  function renderSelectionBar() {
    var items = pickedItems();
    var bar = $('#selBar');
    bar.hidden = items.length === 0;
    document.body.classList.toggle('has-selection', items.length > 0);
    if (items.length) $('#selCount').textContent = items.length;
  }

  function renderList() {
    var host = $('#proposalList');
    var session = activeSession();
    if (!session) {
      host.innerHTML = '' +
        '<div class="empty">' +
          '<i data-lucide="clipboard-list"></i>' +
          '<h3>還沒有會議場次</h3>' +
          '<p>建立場次後即可登錄提案，並匯出 Excel 與 Word。</p>' +
          '<button class="btn primary" data-act="newSession"><i data-lucide="calendar-plus"></i>新增會議場次</button>' +
          '<button class="btn" data-act="seed" style="margin-left:6px;"><i data-lucide="sparkles"></i>載入範例資料</button>' +
        '</div>';
      icons();
      return;
    }
    var list = visibleProposals();
    if (!list.length) {
      var hasAny = (session.proposals || []).length > 0;
      host.innerHTML = '' +
        '<div class="empty">' +
          '<i data-lucide="' + (hasAny ? 'search-x' : 'file-plus-2') + '"></i>' +
          '<h3>' + (hasAny ? '沒有符合條件的提案' : '本場次尚無提案') + '</h3>' +
          '<p>' + (hasAny ? '試著清除搜尋或切換狀態篩選。' : '新增第一筆提案，或載入範例資料看看版面。') + '</p>' +
          '<button class="btn primary" data-act="newProposal"><i data-lucide="plus"></i>新增提案</button>' +
        '</div>';
      icons();
      return;
    }
    host.innerHTML = list.map(rowHTML).join('');
    icons();
  }

  function fillValues(root, source, keys) {
    keys.forEach(function (key) {
      var el = root.querySelector('[data-k="' + key + '"]');
      if (el) el.value = source[key] == null ? '' : source[key];
    });
  }

  function renderInspector() {
    var inspector = $('#inspector');
    var session = activeSession();
    var pending = state.pending;
    var proposal = pending || activeProposal();

    if (!session || !state.inspectorOpen) {
      inspector.hidden = true;
      $('.workspace').classList.add('no-inspector');
      return;
    }
    inspector.hidden = false;
    $('.workspace').classList.remove('no-inspector');

    if (state.panel === 'proposal' && !proposal) state.panel = 'session';
    Array.prototype.forEach.call(document.querySelectorAll('#inspSwitch .seg'), function (seg) {
      var on = seg.dataset.panel === state.panel;
      seg.classList.toggle('is-on', on);
      seg.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    var body = $('#inspBody');
    if (state.panel === 'session') {
      body.innerHTML = sessionFormHTML();
      fillValues(body, session, ['term', 'round', 'date', 'time', 'place', 'chair', 'recorder', 'laborReps', 'mgmtReps', 'note']);
    } else {
      body.innerHTML = proposalFormHTML(proposal, !!pending);
      fillValues(body, proposal, ['no', 'status', 'proposer',
        'subject', 'description', 'method', 'resolution', 'unit', 'dueDate']);
      if (pending && state.pendingInvalid) {
        var subject = body.querySelector('#f-subject');
        if (subject) subject.classList.add('is-invalid');
      }
    }
    icons();
  }

  function proposalFormHTML(p, isPending) {
    var head = isPending
      ? '<div class="pending-bar">' +
          '<span class="pending-title"><i data-lucide="file-pen-line"></i>新提案</span>' +
          '<span class="pending-actions">' +
            '<button class="btn" data-act="cancelPending">取消</button>' +
            '<button class="btn primary" data-act="commitPending"><i data-lucide="check"></i>建立</button>' +
          '</span>' +
        '</div>'
      : '';

    var footer = isPending
      ? '<div class="insp-actions">' +
          '<button class="btn primary" data-act="commitPending"><i data-lucide="check"></i>建立提案</button>' +
          '<button class="btn" data-act="cancelPending">取消</button>' +
        '</div>'
      : '<div class="insp-actions">' +
          '<button class="btn" data-act="wordOne" data-id="' + p.id + '"><i class="office-ico word" aria-hidden="true"></i>匯出提案單</button>' +
          '<button class="btn" data-act="duplicate" data-id="' + p.id + '"><i data-lucide="copy"></i>複製</button>' +
          '<button class="btn danger" data-act="deleteProposal" data-id="' + p.id + '"><i data-lucide="trash-2"></i>刪除</button>' +
        '</div>';

    return '' +
      head +
      '<div class="form-section">' +
        '<h3>基本資料</h3>' +
        '<div class="card grid-2">' +
          '<div class="field"><label for="f-no">案號</label><input id="f-no" type="text" data-k="no" placeholder="勞20260001"></div>' +
          '<div class="field"><label for="f-status">狀態</label><select id="f-status" data-k="status">' + options(STATUS, p.status) + '</select></div>' +
          '<div class="field"><label for="f-proposer">提案人</label><input id="f-proposer" type="text" data-k="proposer"></div>' +
          '<div class="field"><label for="f-unit">執行單位</label><input id="f-unit" type="text" data-k="unit"></div>' +
          '<div class="field"><label for="f-due">辦理期限</label><input id="f-due" type="date" data-k="dueDate"></div>' +
        '</div>' +
      '</div>' +
      '<div class="form-section">' +
        '<h3>提案內容</h3>' +
        '<div class="card">' +
          '<div class="field wide"><label for="f-subject">案由 <span class="req">必填</span></label>' +
            '<textarea id="f-subject" rows="2" data-k="subject" placeholder="一句話說明本次提案重點"></textarea>' +
            (isPending && state.pendingInvalid ? '<p class="field-error">請先填寫案由，才能建立提案。</p>' : '') +
          '</div>' +
          '<div class="field wide"><label for="f-desc">說明</label>' +
            '<textarea id="f-desc" rows="4" data-k="description" placeholder="每行一點，匯出時自動編號"></textarea>' +
            '<p class="hint">一行寫一點。若沒有自行編號，匯出時會自動加上「一、二、三、」。</p></div>' +
          '<div class="field wide"><label for="f-method">辦法</label>' +
            '<textarea id="f-method" rows="4" data-k="method" placeholder="具體建議作法"></textarea></div>' +
          '<div class="field wide"><label for="f-resolve">決議</label>' +
            '<textarea id="f-resolve" rows="3" data-k="resolution" placeholder="會議決議內容"></textarea></div>' +
        '</div>' +
      '</div>' +
      footer;
  }

  function sessionFormHTML() {
    return '' +
      '<div class="form-section">' +
        '<h3>會議場次</h3>' +
        '<div class="card">' +
          '<div class="field"><label for="s-term">屆次</label><input id="s-term" type="text" data-k="term" placeholder="第3屆"></div>' +
          '<div class="field"><label for="s-round">次別</label><input id="s-round" type="text" data-k="round" placeholder="第8次"></div>' +
          '<div class="field"><label for="s-date">開會日期</label><input id="s-date" type="date" data-k="date"></div>' +
          '<div class="field"><label for="s-time">開會時間</label><input id="s-time" type="time" data-k="time"></div>' +
          '<div class="field"><label for="s-place">開會地點</label><input id="s-place" type="text" data-k="place"></div>' +
        '</div>' +
      '</div>' +
      '<div class="form-section">' +
        '<h3>出席與紀錄</h3>' +
        '<div class="card">' +
          '<div class="field"><label for="s-chair">主席</label><input id="s-chair" type="text" data-k="chair"></div>' +
          '<div class="field"><label for="s-rec">紀錄</label><input id="s-rec" type="text" data-k="recorder"></div>' +
          '<div class="field wide"><label for="s-labor">勞方代表</label><input id="s-labor" type="text" data-k="laborReps" placeholder="以頓號分隔"></div>' +
          '<div class="field wide"><label for="s-mgmt">資方代表</label><input id="s-mgmt" type="text" data-k="mgmtReps" placeholder="以頓號分隔"></div>' +
          '<div class="field wide"><label for="s-note">備註</label><textarea id="s-note" rows="3" data-k="note"></textarea></div>' +
        '</div>' +
      '</div>' +
      '<div class="insp-actions">' +
        '<button class="btn" data-act="wordSession"><i class="office-ico word" aria-hidden="true"></i>匯出本場次提案單</button>' +
        '<button class="btn" data-act="excelSession"><i class="office-ico excel" aria-hidden="true"></i>匯出本場次 Excel</button>' +
        '<button class="btn danger" data-act="deleteSession" data-id="' + state.activeSessionId + '"><i data-lucide="trash-2"></i>刪除場次</button>' +
      '</div>';
  }

  function tally(list, key) {
    var map = {};
    list.forEach(function (item) {
      var k = item[key] || '（未填）';
      map[k] = (map[k] || 0) + 1;
    });
    return map;
  }

  function barRows(map, total) {
    var keys = Object.keys(map);
    if (!keys.length) return '<p class="hint">尚無資料</p>';
    return keys.map(function (key) {
      var percent = total ? Math.round((map[key] / total) * 100) : 0;
      return '' +
        '<div class="bar-row">' +
          '<div class="bar-top"><span>' + esc(key) + '</span><span class="bv">' + map[key] + ' 件・' + percent + '%</span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + percent + '%"></div></div>' +
        '</div>';
    }).join('');
  }

  function renderStats() {
    var host = $('#statsView');
    var all = [];
    state.sessions.forEach(function (session) {
      (session.proposals || []).forEach(function (p) { all.push(p); });
    });
    var byStatus = tally(all, 'status');
    var tracking = byStatus['列管中'] || 0;
    var draft = byStatus['草稿'] || 0;
    var closed = byStatus['結案'] || 0;

    var sessionTally = {};
    state.sessions.forEach(function (session) {
      sessionTally[sessionLabel(session)] = (session.proposals || []).length;
    });

    host.innerHTML = '' +
      '<div class="content-head"><div class="ch-title"><h2>統計總覽</h2>' +
        '<p>' + state.sessions.length + ' 場次・' + all.length + ' 件提案</p></div></div>' +
      '<div class="tiles">' +
        tile('提案總數', all.length, '件') +
        tile('草稿', draft, '件') +
        tile('列管中', tracking, '件') +
        tile('結案', closed, '件') +
      '</div>' +
      '<div class="panels">' +
        panel('依狀態分佈', barRows(byStatus, all.length)) +
        panel('依執行單位分佈', barRows(tally(all, 'unit'), all.length)) +
        panel('各場次提案數', barRows(sessionTally, all.length)) +
      '</div>';
  }

  function tile(label, value, unit) {
    return '<div class="tile"><div class="k">' + esc(label) + '</div>' +
      '<div class="v">' + value + '<small>' + esc(unit) + '</small></div></div>';
  }

  function panel(title, inner) {
    return '<section class="panel"><h3>' + esc(title) + '</h3>' + inner + '</section>';
  }

  function renderView() {
    $('#listView').hidden = state.view !== 'list';
    $('#statsView').hidden = state.view !== 'stats';
    Array.prototype.forEach.call(document.querySelectorAll('#viewSwitch .seg'), function (seg) {
      var on = seg.dataset.view === state.view;
      seg.classList.toggle('is-on', on);
      seg.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (state.view === 'stats') renderStats();
  }

  function renderAll() {
    renderSessions();
    renderHead();
    renderFilters();
    renderList();
    renderSelectionBar();
    renderInspector();
    renderView();
    save();
  }

  /* ── 提示訊息 ─────────────────────────────────────────────── */

  var toastTimer = null;
  function toast(message) {
    var el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // 手機（iOS／Android）優先叫用系統分享選單，使用者才能「儲存到檔案」或轉傳；
  // 桌機或瀏覽器不支援時，改用一般下載連結。
  function deliverFile(blob, filename, type) {
    var file = null;
    try {
      file = new window.File([blob], filename, { type: type || blob.type });
    } catch (err) {
      file = null;
    }
    // 只在觸控裝置（手機／平板）走分享選單；桌機 Chrome 雖也支援 Web Share，
    // 但使用者預期的是「直接下載」，不該跳出系統分享面板。
    var isTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    if (file && isTouch && navigator.canShare && navigator.share) {
      try {
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: filename }).then(function () {
            toast('已開啟分享選單，可選「儲存到檔案」');
          }).catch(function (err) {
            if (err && err.name === 'AbortError') return;
            downloadBlob(blob, filename);
          });
          return;
        }
      } catch (err) { /* 不支援檔案分享時改用下載 */ }
    }
    downloadBlob(blob, filename);
  }

  /* ── 匯出 ─────────────────────────────────────────────────── */

  function exportExcel(sessions) {
    var list = (sessions && sessions.length ? sessions : state.sessions).filter(Boolean);
    if (!list.length) return toast('尚無資料可匯出');
    var workbook = E.buildWorkbook(window.XLSX, list);
    var name = E.excelFileName(list);
    var data = window.XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    var blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    deliverFile(blob, name, blob.type);
    toast('已匯出 Excel：' + name);
  }

  function exportWord(items) {
    if (!items || !items.length) return toast('沒有可匯出的提案');
    var doc = E.buildProposalDocument(window.docx, items);
    window.docx.Packer.toBlob(doc).then(function (blob) {
      var name = E.wordFileName(items);
      deliverFile(blob, name, blob.type);
      toast('已匯出 Word：' + name);
    }).catch(function () {
      toast('Word 匯出失敗，請再試一次');
    });
  }

  function exportJson() {
    var payload = JSON.stringify({ exportedAt: new Date().toISOString(), sessions: state.sessions }, null, 2);
    deliverFile(new Blob([payload], { type: 'application/json' }),
      '勞資會議提案備份_' + todayISO().replace(/-/g, '') + '.json', 'application/json');
    toast('已匯出備份檔');
  }

  /* ── 動作 ─────────────────────────────────────────────────── */

  function emptyProposal() {
    return {
      id: uid('p'), no: '', proposer: '',
      subject: '', description: '', method: '', resolution: '',
      unit: '', dueDate: '', status: '草稿'
    };
  }

  // 案號格式：勞 + 西元年 + 4 碼流水號，序號依建立順序遞增（同一年共用）
  function nextProposalNo() {
    var year = new Date().getFullYear();
    var max = 0;
    state.sessions.forEach(function (session) {
      (session.proposals || []).forEach(function (p) {
        var found = /^勞(\d{4})(\d{4})$/.exec(String(p.no || ''));
        if (found && Number(found[1]) === year) max = Math.max(max, Number(found[2]));
      });
    });
    return '勞' + year + String(max + 1).padStart(4, '0');
  }

  function addSession() {
    var session = {
      id: uid('s'), term: state.sessions.length ? (activeSession() || {}).term || '第1屆' : '第1屆',
      round: '第' + (state.sessions.length + 1) + '次', date: todayISO(), time: '14:00',
      place: '', chair: '', recorder: '', laborReps: '', mgmtReps: '', note: '',
      proposals: []
    };
    state.sessions.push(session);
    state.activeSessionId = session.id;
    state.activeProposalId = null;
    state.pending = null;
    state.view = 'list';
    renderAll();
    toast('已新增會議場次');
    addProposal(); // 新場次直接進入第一筆提案的表單
  }

  function addProposal() {
    var session = activeSession();
    if (!session) return addSession();
    // 已經在建立新提案時，把游標帶回表單就好，不要再多開一張
    if (state.pending) {
      openInspector();
      focusField('subject');
      toast('正在建立新提案，填好案由後按「建立」');
      return;
    }
    // 新提案先不進清單，填好按「建立」才成立
    var proposal = emptyProposal();
    proposal.no = nextProposalNo();
    state.pending = proposal;
    state.pendingReturnId = state.activeProposalId;
    state.pendingInvalid = false;
    state.activeProposalId = null;
    state.panel = 'proposal';
    state.view = 'list';
    renderAll();
    openInspector();
    focusField('subject');
  }

  function duplicateProposal(id) {
    var session = activeSession();
    if (!session) return;
    var index = (session.proposals || []).findIndex(function (p) { return p.id === id; });
    if (index < 0) return;
    var copy = JSON.parse(JSON.stringify(session.proposals[index]));
    copy.id = uid('p');
    copy.status = '草稿';
    copy.resolution = '';
    copy.no = nextProposalNo();
    session.proposals.splice(index + 1, 0, copy);
    state.activeProposalId = copy.id;
    state.panel = 'proposal';
    renderAll();
    openInspector();
    revealProposal(copy.id);
    focusField('subject');
    toast('已複製提案');
  }

  function togglePick(id) {
    if (state.selection[id]) delete state.selection[id];
    else state.selection[id] = true;
    var item = findProposal(id);
    var row = document.querySelector('.prow[data-id="' + id + '"]');
    if (item && row) {
      row.outerHTML = rowHTML(item.proposal);
      icons();
    }
    renderSelectionBar();
  }

  function pickAllVisible() {
    visibleProposals().forEach(function (p) { state.selection[p.id] = true; });
    renderList();
    renderSelectionBar();
  }

  function deleteProposal(id) {
    var session = activeSession();
    if (!session) return;
    var target = (session.proposals || []).find(function (p) { return p.id === id; });
    if (!target) return;
    // 空白提案沒東西可失去，直接刪除不跳確認；有內容的才需要確認
    if (!isBlankProposal(target)
      && !window.confirm('確定刪除提案「' + (target.subject || target.no || '未命名') + '」？')) return;
    session.proposals = session.proposals.filter(function (p) { return p.id !== id; });
    delete state.selection[id];
    if (state.activeProposalId === id) {
      state.activeProposalId = session.proposals.length ? session.proposals[0].id : null;
    }
    renderAll();
    toast('已刪除提案');
  }

  function deletePicked() {
    var items = pickedItems();
    if (!items.length) return;
    var hasContent = items.some(function (item) { return !isBlankProposal(item.proposal); });
    if (hasContent && !window.confirm('確定刪除選取的 ' + items.length + ' 件提案？')) return;
    items.forEach(function (item) {
      item.session.proposals = item.session.proposals.filter(function (p) {
        return p.id !== item.proposal.id;
      });
      delete state.selection[item.proposal.id];
    });
    var session = activeSession();
    if (session && !(session.proposals || []).some(function (p) { return p.id === state.activeProposalId; })) {
      state.activeProposalId = session.proposals.length ? session.proposals[0].id : null;
    }
    renderAll();
    toast('已刪除 ' + items.length + ' 件提案');
  }

  function deleteSession(id) {
    var session = state.sessions.find(function (s) { return s.id === id; });
    if (!session) return;
    if (!window.confirm('確定刪除場次「' + sessionLabel(session) + '」及其 ' + (session.proposals || []).length + ' 件提案？')) return;
    (session.proposals || []).forEach(function (p) { delete state.selection[p.id]; });
    state.sessions = state.sessions.filter(function (s) { return s.id !== id; });
    if (state.activeSessionId === id) {
      var next = state.sessions[0] || null;
      state.activeSessionId = next ? next.id : null;
      state.activeProposalId = next && next.proposals.length ? next.proposals[0].id : null;
      if (!next) state.inspectorOpen = false;
    }
    renderAll();
    toast('已刪除場次');
  }

  function selectSession(id) {
    var session = state.sessions.find(function (s) { return s.id === id; });
    if (!session) return;
    settlePending();
    state.activeSessionId = id;
    state.activeProposalId = (session.proposals || []).length ? session.proposals[0].id : null;
    state.panel = state.activeProposalId ? 'proposal' : 'session';
    state.statusFilter = 'all';
    renderAll();
    openInspector();
  }

  function selectProposal(id) {
    settlePending();
    state.activeProposalId = id;
    state.panel = 'proposal';
    renderAll();
    openInspector();
  }

  function syncProposalRow(proposal) {
    var el = document.querySelector('.prow[data-id="' + proposal.id + '"]');
    if (!el) return;
    el.outerHTML = rowHTML(proposal);
    icons();
  }

  function syncSessionChrome() {
    renderSessions();
    renderHead();
  }

  /* ── 事件 ─────────────────────────────────────────────────── */

  function closeMenu() {
    var menu = $('#moreMenu');
    menu.hidden = true;
    $('#moreBtn').setAttribute('aria-expanded', 'false');
  }

  function onInspectorInput(event) {
    var el = event.target.closest('[data-k]');
    if (!el) return;
    var key = el.dataset.k;
    if (state.panel === 'proposal') {
      var proposal = editingProposal();
      if (!proposal) return;
      proposal[key] = el.value;
      if (state.pending) {
        // 建立中的提案還沒進清單，補上案由後把錯誤提示收掉即可
        if (state.pendingInvalid && String(state.pending.subject || '').trim()) {
          state.pendingInvalid = false;
          var input = document.querySelector('#f-subject');
          if (input) input.classList.remove('is-invalid');
          var error = document.querySelector('#inspBody .field-error');
          if (error) error.remove();
        }
      } else {
        syncProposalRow(proposal);
      }
    } else {
      var session = activeSession();
      if (!session) return;
      session[key] = el.value;
      syncSessionChrome();
    }
    save();
  }

  function init() {
    if (!load()) {
      seedData();
      save();
    }
    if (!state.activeSessionId && state.sessions.length) state.activeSessionId = state.sessions[0].id;
    // 手機先看提案清單，點選提案或新增時才打開編輯面板
    state.inspectorOpen = !!state.activeSessionId && !isNarrow();
    applyTheme();
    if (!storageOK) $('#storageNotice').hidden = false;
    renderAll();

    $('#noticeClose').addEventListener('click', function () {
      $('#storageNotice').hidden = true;
    });

    document.addEventListener('click', function (event) {
      var menuWrap = event.target.closest('.menu-wrap');
      if (!menuWrap) closeMenu();
    });

    $('#moreBtn').addEventListener('click', function () {
      var menu = $('#moreMenu');
      menu.hidden = !menu.hidden;
      this.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });

    $('#moreMenu').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-act]');
      if (!button) return;
      closeMenu();
      var act = button.dataset.act;
      if (act === 'newSession') addSession();
      else if (act === 'exportJson') exportJson();
      else if (act === 'importJson') $('#importFile').click();
      else if (act === 'seed') {
        if (!state.sessions.length || window.confirm('載入範例資料會覆蓋目前的場次與提案，確定繼續？')) {
          seedData();
          state.inspectorOpen = true;
          renderAll();
          toast('已載入範例資料');
        }
      } else if (act === 'clear') {
        if (window.confirm('確定清除全部場次與提案？此動作無法復原。')) {
          state.sessions = [];
          state.activeSessionId = null;
          state.activeProposalId = null;
          state.inspectorOpen = false;
          renderAll();
          toast('已清除全部資料');
        }
      }
    });

    $('#importFile').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result));
          var sessions = Array.isArray(data) ? data : data.sessions;
          if (!Array.isArray(sessions)) throw new Error('格式錯誤');
          state.sessions = sessions;
          state.activeSessionId = sessions[0] ? sessions[0].id : null;
          state.activeProposalId = sessions[0] && sessions[0].proposals && sessions[0].proposals[0]
            ? sessions[0].proposals[0].id : null;
          state.inspectorOpen = !!state.activeSessionId;
          renderAll();
          toast('已匯入 ' + sessions.length + ' 個場次');
        } catch (err) {
          toast('匯入失敗：檔案格式不正確');
        }
        event.target.value = '';
      };
      reader.readAsText(file);
    });

    $('#viewSwitch').addEventListener('click', function (event) {
      var seg = event.target.closest('.seg');
      if (!seg) return;
      state.view = seg.dataset.view;
      renderView();
    });

    $('#filters').addEventListener('click', function (event) {
      var chip = event.target.closest('.fchip');
      if (!chip) return;
      state.statusFilter = chip.dataset.status;
      renderFilters();
      renderList();
    });

    $('#sessionList').addEventListener('click', function (event) {
      var del = event.target.closest('[data-act="deleteSession"]');
      if (del) { event.stopPropagation(); deleteSession(del.dataset.id); return; }
      var item = event.target.closest('.session-item');
      if (item) selectSession(item.dataset.id);
    });

    $('#listView').addEventListener('click', function (event) {
      var action = event.target.closest('[data-act]');
      if (action) {
        event.stopPropagation();
        var act = action.dataset.act;
        if (act === 'pick') togglePick(action.dataset.id);
        else if (act === 'pickAll') pickAllVisible();
        else if (act === 'pickNone') { state.selection = {}; renderList(); renderSelectionBar(); }
        else if (act === 'pickDelete') deletePicked();
        else if (act === 'wordPicked') exportWord(pickedItems());
        else if (act === 'duplicate') duplicateProposal(action.dataset.id);
        else if (act === 'wordOne') {
          var item = findProposal(action.dataset.id);
          if (item) exportWord([item]);
        } else if (act === 'newProposal') addProposal();
        else if (act === 'newSession') addSession();
        else if (act === 'seed') {
          seedData();
          state.inspectorOpen = true;
          renderAll();
        }
        return;
      }
      var row = event.target.closest('.prow');
      if (row) selectProposal(row.dataset.id);
    });

    $('#listView').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var row = event.target.closest('.prow');
      if (!row) return;
      event.preventDefault();
      selectProposal(row.dataset.id);
    });

    $('#inspBody').addEventListener('input', onInspectorInput);
    $('#inspBody').addEventListener('change', function (event) {
      if (event.target.tagName === 'SELECT') onInspectorInput(event);
    });

    $('#inspBody').addEventListener('click', function (event) {
      var action = event.target.closest('[data-act]');
      if (!action) return;
      var act = action.dataset.act;
      if (act === 'commitPending') commitPending(false);
      else if (act === 'cancelPending') cancelPending();
      else if (act === 'duplicate') duplicateProposal(action.dataset.id);
      else if (act === 'deleteProposal') deleteProposal(action.dataset.id);
      else if (act === 'wordOne') {
        var item = findProposal(action.dataset.id);
        if (item) exportWord([item]);
      } else if (act === 'wordSession') exportWord(sessionItems(activeSession()));
      else if (act === 'excelSession') exportExcel([activeSession()]);
      else if (act === 'deleteSession') deleteSession(action.dataset.id);
    });

    $('#inspSwitch').addEventListener('click', function (event) {
      var seg = event.target.closest('.seg');
      if (!seg) return;
      if (seg.dataset.panel === 'session') settlePending();
      state.panel = seg.dataset.panel;
      renderInspector();
    });

    $('#inspClose').addEventListener('click', function () {
      settlePending();
      state.inspectorOpen = false;
      renderInspector();
    });

    $('#addBtn').addEventListener('click', addProposal);
    $('#addSessionBtn').addEventListener('click', addSession);
    $('#editSessionBtn').addEventListener('click', function () {
      settlePending();
      state.panel = 'session';
      state.inspectorOpen = true;
      renderInspector();
    });
    $('#excelBtn').addEventListener('click', function () { exportExcel(); });
    $('#wordBtn').addEventListener('click', function () {
      var session = activeSession();
      if (session) exportWord(sessionItems(session));
    });
    $('#themeBtn').addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      state.theme = current === 'dark' ? 'light' : 'dark';
      applyTheme();
      save();
    });

    var searchTimer = null;
    $('#searchInput').addEventListener('input', function () {
      var value = this.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.query = value;
        renderList();
      }, 120);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeMenu();
        if (state.inspectorOpen && window.matchMedia('(max-width: 1000px)').matches) {
          state.inspectorOpen = false;
          renderInspector();
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        $('#searchInput').focus();
      }
    });

    var schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    var onSchemeChange = function () {
      if (state.theme !== 'light' && state.theme !== 'dark') applyTheme();
    };
    if (schemeQuery.addEventListener) schemeQuery.addEventListener('change', onSchemeChange);
    else if (schemeQuery.addListener) schemeQuery.addListener(onSchemeChange);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
