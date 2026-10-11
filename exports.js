/*
 * 匯出模組：同時可在瀏覽器（window.Exporters）與 Node（require）使用，
 * 方便直接驗證輸出的 .xlsx / .docx 內容。
 * 純資料轉換，不碰 DOM。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Exporters = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEADERS = ['屆次', '次別', '開會日期', '案號', '類別', '提案方', '提案人', '連署人',
                 '案由', '說明', '辦法', '決議', '執行單位', '辦理期限', '狀態'];
  var WIDTHS = [8, 6, 12, 12, 10, 10, 10, 12, 34, 46, 46, 34, 14, 12, 8];

  var CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var PRE_NUMBERED = /^\s*(([0-9]+|[一二三四五六七八九十]+)\s*[.、)）]|[（(]\s*([0-9]+|[一二三四五六七八九十]+)\s*[）)]|[-•*·])\s*/;

  function cnNumber(n) {
    if (n < 10) return CN_DIGITS[n];
    if (n === 10) return '十';
    if (n < 20) return '十' + CN_DIGITS[n - 10];
    if (n < 100) return CN_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? CN_DIGITS[n % 10] : '');
    return String(n);
  }

  // 每行自動加上「一、二、三、」編號；若使用者已自行編號則整段沿用，避免撞號。
  function numberLines(text, options) {
    var opts = options || {};
    var style = opts.style || 'cn'; // 'cn' → 一、 ／ 'digit' → 1.
    var lines = String(text == null ? '' : text).split(/\r?\n/)
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });

    if (lines.some(function (line) { return PRE_NUMBERED.test(line); })) return lines;

    return lines.map(function (line, index) {
      var n = index + 1;
      return (style === 'digit' ? n + '.' : cnNumber(n) + '、') + ' ' + line;
    });
  }

  function numberedText(text) {
    return numberLines(text).join('\n');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // '2026-09-18' → '2026/09/18'
  function slashDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return m ? m[1] + '/' + m[2] + '/' + m[3] : (value || '');
  }

  // '2026-09-18' → '民國115年9月18日'
  function rocDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) return value || '';
    return '民國' + (Number(m[1]) - 1911) + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
  }

  function sessionLabel(session) {
    if (!session) return '';
    return [session.term, session.round].filter(Boolean).join(' ') || '未命名場次';
  }

  function proposalRow(session, p) {
    return [
      session.term || '',
      session.round || '',
      slashDate(session.date),
      p.no || '',
      p.category || '',
      p.side || '',
      p.proposer || '',
      p.coSigners || '',
      p.subject || '',
      numberedText(p.description),
      numberedText(p.method),
      numberedText(p.resolution),
      p.unit || '',
      slashDate(p.dueDate),
      p.status || ''
    ];
  }

  function safeSheetName(name, used) {
    var base = String(name || '工作表').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || '工作表';
    var candidate = base;
    var i = 2;
    while (used.indexOf(candidate) >= 0) {
      var suffix = '(' + i + ')';
      candidate = base.slice(0, 31 - suffix.length) + suffix;
      i += 1;
    }
    used.push(candidate);
    return candidate;
  }

  // 依欄寬估算換行後的列高，讓 Excel 開啟時看得到多行內容。
  function sheetRows(cells, header) {
    var lines = 1;
    cells.forEach(function (value, i) {
      var text = String(value == null ? '' : value);
      var perLine = Math.max(4, Math.floor((WIDTHS[i] || 12) * 1.05));
      text.split('\n').forEach(function (line) {
        lines = Math.max(lines, Math.ceil(Math.max(1, line.length) / perLine));
      });
    });
    return { hpt: Math.min(200, (lines + (header ? 0.2 : 0)) * 15.6 + 4) };
  }

  function appendSheet(XLSX, workbook, name, rows) {
    var sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = WIDTHS.map(function (w) { return { wch: w }; });
    sheet['!rows'] = rows.map(function (row, i) { return sheetRows(row, i === 0); });
    XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(name, workbook._lmNames));
    return sheet;
  }

  /**
   * 建立 Excel 活頁簿：提案總覽、會議場次、每個場次明細、統計。
   * @param {object} XLSX SheetJS 模組
   * @param {Array} sessions 會議場次（含 proposals）
   */
  function buildWorkbook(XLSX, sessions) {
    var list = (sessions || []).filter(Boolean);
    var workbook = XLSX.utils.book_new();
    workbook._lmNames = [];

    var overview = [HEADERS];
    list.forEach(function (session) {
      (session.proposals || []).forEach(function (p) { overview.push(proposalRow(session, p)); });
    });
    appendSheet(XLSX, workbook, '提案總覽', overview);

    var infoRows = [[
      '屆次', '次別', '開會日期', '開會時間', '開會地點', '主席', '紀錄',
      '勞方代表', '資方代表', '提案件數', '備註'
    ]];
    list.forEach(function (session) {
      infoRows.push([
        session.term || '', session.round || '', slashDate(session.date), session.time || '',
        session.place || '', session.chair || '', session.recorder || '',
        session.laborReps || '', session.mgmtReps || '',
        (session.proposals || []).length, session.note || ''
      ]);
    });
    appendSheet(XLSX, workbook, '會議場次', infoRows);

    list.forEach(function (session) {
      var rows = [HEADERS.slice(3)];
      (session.proposals || []).forEach(function (p) { rows.push(proposalRow(session, p).slice(3)); });
      appendSheet(XLSX, workbook, sessionLabel(session), rows);
    });

    var all = [];
    list.forEach(function (session) {
      (session.proposals || []).forEach(function (p) { all.push(p); });
    });
    function tally(key) {
      var map = {};
      all.forEach(function (p) {
        var k = p[key] || '（未填）';
        map[k] = (map[k] || 0) + 1;
      });
      return map;
    }
    var statRows = [['統計項目', '項目', '數量'], ['總計', '提案總數', all.length]];
    [['狀態', 'status'], ['類別', 'category'], ['提案方', 'side']].forEach(function (pair) {
      var map = tally(pair[1]);
      Object.keys(map).forEach(function (k) { statRows.push([pair[0], k, map[k]]); });
    });
    list.forEach(function (session) {
      statRows.push(['場次', sessionLabel(session), (session.proposals || []).length]);
    });
    appendSheet(XLSX, workbook, '統計', statRows);

    delete workbook._lmNames;
    return workbook;
  }

  /**
   * 建立 Word 提案單：一案一頁，正式表格式版面。
   * @param {object} docx docx 模組
   * @param {Array} items [{ session, proposal }]，可跨場次批次合併成一份文件
   */
  function buildProposalDocument(docx, items) {
    var D = docx;
    var list = (items || []).filter(function (item) { return item && item.proposal; });
    var BORDER = { style: D.BorderStyle.SINGLE, size: 6, color: '3C3C43' };
    var borders = {
      top: BORDER, bottom: BORDER, left: BORDER, right: BORDER,
      insideHorizontal: BORDER, insideVertical: BORDER
    };
    var CJK = { ascii: 'Times New Roman', eastAsia: '標楷體', hAnsi: 'Times New Roman', hint: 'eastAsia' };

    function lines(text, opts) {
      var o = opts || {};
      var parts = Array.isArray(text) ? text : String(text == null ? '' : text).split('\n');
      if (!parts.length) parts = [''];
      return parts.map(function (line) {
        return new D.Paragraph({
          alignment: o.align,
          spacing: { before: o.before || 0, after: o.after == null ? 0 : o.after, line: o.line || 300 },
          children: [new D.TextRun({
            text: line,
            bold: !!o.bold,
            size: o.size || 24,
            font: o.font || CJK
          })]
        });
      });
    }

    function cell(text, opts) {
      var o = opts || {};
      return new D.TableCell({
        width: { size: o.w || 17, type: D.WidthType.PERCENTAGE },
        columnSpan: o.span || 1,
        verticalAlign: D.VerticalAlign.CENTER,
        shading: o.shade ? { fill: 'F0F0F2', type: 'clear', color: 'auto' } : undefined,
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        children: lines(text, {
          bold: o.bold,
          align: o.align,
          size: o.size || 24,
          line: o.line
        })
      });
    }

    function row(cells) { return new D.TableRow({ children: cells }); }

    function label(text) { return cell(text, { w: 17, bold: true, shade: true, align: D.AlignmentType.CENTER }); }
    function value(text) { return cell(text, { w: 33, align: D.AlignmentType.LEFT }); }
    function merged(text, span) { return cell(text, { w: 83, span: span || 3, align: D.AlignmentType.LEFT }); }

    function proposalTable(item) {
      var session = item.session;
      var p = item.proposal;
      return new D.Table({
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        layout: D.TableLayoutType && D.TableLayoutType.FIXED,
        columnWidths: [1638, 3181, 1638, 3181], // 內容寬度 9638 twips，17% / 33% / 17% / 33%
        borders: borders,
        rows: [
          row([label('屆　次'), value(session.term), label('次　別'), value(session.round)]),
          row([label('開會日期'), value(rocDate(session.date)), label('提案編號'), value(p.no)]),
          row([label('類　別'), value(p.category), label('提案方'), value(p.side)]),
          row([label('提案人'), value(p.proposer), label('連署人'), value(p.coSigners)]),
          row([label('案　由'), merged(p.subject)]),
          row([label('說　明'), merged(numberLines(p.description).join('\n'))]),
          row([label('辦　法'), merged(numberLines(p.method).join('\n'))]),
          row([label('決　議'), merged(numberLines(p.resolution).join('\n'))]),
          row([label('執行單位'), value(p.unit), label('辦理期限'), value(slashDate(p.dueDate))]),
          row([label('狀　態'), merged(p.status || '草稿')])
        ]
      });
    }

    var children = [];
    list.forEach(function (item, index) {
      children.push(new D.Paragraph({
        pageBreakBefore: index > 0,
        alignment: D.AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new D.TextRun({ text: '勞資會議提案單', bold: true, size: 40, font: CJK })]
      }));
      children.push(new D.Paragraph({
        alignment: D.AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new D.TextRun({
          text: sessionLabel(item.session) + '　' + rocDate(item.session.date)
            + (item.session.place ? '　地點：' + item.session.place : ''),
          size: 22,
          font: CJK
        })]
      }));
      children.push(proposalTable(item));
      if (index < list.length - 1) {
        children.push(new D.Paragraph({ spacing: { after: 0 }, children: [] }));
      }
    });

    if (!list.length) children.push(new D.Paragraph({ children: [new D.TextRun({ text: '（無提案）', font: CJK })] }));

    return new D.Document({
      creator: '勞資會議提案系統',
      title: '勞資會議提案單 ' + (list[0] ? sessionLabel(list[0].session) : ''),
      styles: {
        default: {
          document: { run: { font: CJK, size: 24 }, paragraph: { spacing: { line: 300 } } }
        }
      },
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } // 2 cm
          }
        },
        children: children
      }]
    });
  }

  function stamp(date) {
    var d = date || new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  function excelFileName(sessions, date) {
    var list = (sessions || []).filter(Boolean);
    var scope = list.length === 1 ? sessionLabel(list[0]).replace(/\s+/g, '') : '全部場次';
    return '勞資會議提案總表_' + scope + '_' + stamp(date) + '.xlsx';
  }

  // items = [{ session, proposal }]；同一場次用場次名，跨場次標示合併件數。
  function wordFileName(items, date) {
    var list = (items || []).filter(function (item) { return item && item.session; });
    var labels = [];
    list.forEach(function (item) {
      var label = sessionLabel(item.session);
      if (labels.indexOf(label) < 0) labels.push(label);
    });
    var scope = labels.length === 1
      ? labels[0].replace(/\s+/g, '')
      : '跨場次' + list.length + '件';
    return '勞資會議提案單_' + (scope || '提案單') + '_' + stamp(date) + '.docx';
  }

  return {
    HEADERS: HEADERS,
    numberLines: numberLines,
    numberedText: numberedText,
    slashDate: slashDate,
    rocDate: rocDate,
    sessionLabel: sessionLabel,
    buildWorkbook: buildWorkbook,
    buildProposalDocument: buildProposalDocument,
    excelFileName: excelFileName,
    wordFileName: wordFileName
  };
});
