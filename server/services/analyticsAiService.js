const path = require('path');
const {
  buildManagementContext,
  buildManagementBriefCharts,
} = require('./managementReportBuilder');
const { fetchPyCached } = require('./analyticsPyFetch');
const { sendStreamDeltaIfChanged } = require('../utils/streamingJson');

const VERTEX_PROJECT_ID = 'core-api-495501';
const VERTEX_LOCATION_PRIMARY = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_LOCATION_FALLBACK = 'global';
const MODEL_CANDIDATES = process.env.VERTEX_GEMINI_MODEL
  ? [process.env.VERTEX_GEMINI_MODEL.trim()].filter(Boolean)
  : ['gemini-2.0-flash-lite-001', 'gemini-2.0-flash', 'gemini-2.5-flash'];
const SERVICE_ACCOUNT_KEY_PATH = path.resolve(__dirname, '..', '..', 'core-api-495501-4096e683bc08.json');
const LOG_TIMING = process.env.ANALYTICS_AI_TIMING === '1';

let vertexSdkPromise = null;
const vertexClients = new Map();
/** @type {{ location: string, modelId: string } | null} */
let provenVertexModel = null;

function logTiming(label, ms) {
  if (LOG_TIMING) console.info(`[AnalyticsAI] ${label}: ${ms}ms`);
}

function toYmd(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function previousPeriod(startDate, endDate) {
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return { start: startDate, end: endDate };
  }
  const days = Math.max(1, Math.round((e - s) / 86400000) + 1);
  const prevEnd = new Date(s);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (days - 1));
  return { start: toYmd(prevStart), end: toYmd(prevEnd) };
}

function sumDaily(rows) {
  return (rows || []).reduce(
    (acc, row) => {
      const total = Number(row.total_sales) || 0;
      const refund = Number(row.refund) || 0;
      const discount = Number(row.discount) || 0;
      const net = Number(row.net_sales) || total - refund - discount;
      const gp = Number(row.gross_profit) || 0;
      acc.total_sales += total;
      acc.refund += refund;
      acc.discount += discount;
      acc.net_sales += net;
      acc.gross_profit += gp;
      return acc;
    },
    { total_sales: 0, refund: 0, discount: 0, net_sales: 0, gross_profit: 0 },
  );
}

function topMenuByNet(rows, limit = 10) {
  const map = new Map();
  for (const r of rows || []) {
    const name = String(r.goods || r.MENU_NAME || '').trim() || 'Unknown';
    const net =
      Number(r.netSales) ||
      (Number(r.totalSales) || 0) - (Number(r.refundAmount) || 0) - (Number(r.discounts) || 0);
    map.set(name, (map.get(name) || 0) + net);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, netSales]) => ({ name, netSales: Math.round(netSales * 100) / 100 }));
}

function hasHangul(text) {
  return /[\uAC00-\uD7AF\u3131-\u318E\u1100-\u11FF]/.test(String(text || ''));
}

function resolveResponseLocale(locale, message) {
  const msg = String(message || '');
  if (hasHangul(msg)) return 'ko';
  const loc = String(locale || 'en').toLowerCase();
  if (loc.startsWith('ko')) return 'ko';
  if (loc.startsWith('fil') || loc === 'tl') return 'fil';
  return 'en';
}

function narrativeMatchesLocale(narrative, locale) {
  if (!narrative?.summary) return false;
  const combined = [narrative.summary, ...(narrative.bullets || []), ...(narrative.suggestedReplies || [])].join(
    ' ',
  );
  if (locale === 'ko') return hasHangul(combined);
  if (locale === 'fil') return /\b(ng|sa|ang|mga|net sales|bumaba|tumaas)\b/i.test(combined) || hasHangul(combined);
  return true;
}

function parseNarrativeFromModel(parsed) {
  return {
    summary: String(parsed?.summary || '').trim(),
    bullets: Array.isArray(parsed?.bullets) ? parsed.bullets.map((b) => String(b).trim()).filter(Boolean) : [],
    suggestedReplies: Array.isArray(parsed?.suggestedReplies)
      ? parsed.suggestedReplies.map((s) => String(s).trim()).filter(Boolean).slice(0, 4)
      : [],
  };
}

function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => ({
      role: item.role,
      content: String(item.content || '')
        .trim()
        .slice(0, 2000),
    }))
    .filter((item) => item.content)
    .slice(-12);
}

function formatHistoryForPrompt(locale, history) {
  const items = sanitizeChatHistory(history);
  if (!items.length) return '';
  const lines = items.map((item) => {
    const label =
      item.role === 'user'
        ? locale === 'ko'
          ? '사용자'
          : locale === 'fil'
            ? 'User'
            : 'User'
        : locale === 'ko'
          ? '어시스턴트'
          : 'Assistant';
    return `${label}: ${item.content}`;
  });
  if (locale === 'ko') {
    return `\n이전 대화 (후속 질문 맥락):\n${lines.join('\n')}\n`;
  }
  if (locale === 'fil') {
    return `\nNakaraang usapan (konteksto para sa follow-up):\n${lines.join('\n')}\n`;
  }
  return `\nPrior conversation (context for follow-up questions):\n${lines.join('\n')}\n`;
}

function buildAnalyticsPrompt(locale, message, context, history = []) {
  const historyBlock = formatHistoryForPrompt(locale, history);
  if (locale === 'ko') {
    return `당신은 레스토랑 매출 분석 AI입니다.

**필수 규칙**
- summary, bullets, suggestedReplies의 모든 문장은 반드시 한국어(한국어)로만 작성하세요.
- 영어 문장을 사용하지 마세요. 숫자와 ₱, 날짜, 메뉴명은 그대로 사용해도 됩니다.
- CONTEXT에 있는 숫자만 사용하세요. 새로운 숫자를 만들지 마세요.
- 이전 대화가 있으면 후속 질문(예: "왜?", "더 자세히", "그 지점은?")에 맥락을 반영하세요.
${historyBlock}
사용자 질문: ${message}

CONTEXT (JSON):
${JSON.stringify(context)}

다음 JSON만 반환:
{
  "summary": "2~3문장 한국어 요약",
  "bullets": ["한국어 인사이트 3~5개"],
  "suggestedReplies": ["한국어 후속 질문 3~4개"]
}`;
  }

  if (locale === 'fil') {
    return `You are a restaurant sales analyst. Write summary, bullets, and suggestedReplies in Filipino (Tagalog).
Use ONLY numbers from CONTEXT. Do not invent figures.
If prior conversation exists, use it to answer follow-up questions (e.g. "bakit?", "explain more").
${historyBlock}
User question: ${message}

CONTEXT (JSON):
${JSON.stringify(context)}

Return JSON with summary (2-3 sentences), bullets (3-5), suggestedReplies (3-4).`;
  }

  return `You are a restaurant sales analyst. Write summary, bullets, and suggestedReplies in English.
Use ONLY numbers from CONTEXT. Do not invent figures.
If prior conversation exists, use it to answer follow-up questions (e.g. "why?", "break that down", "which branch?").
${historyBlock}
User question: ${message}

CONTEXT (JSON):
${JSON.stringify(context)}

Return JSON with summary (2-3 sentences), bullets (3-5), suggestedReplies (3-4).`;
}

function buildAnalyticsPlainStreamPrompt(locale, message, context) {
  if (locale === 'ko') {
    return `당신은 레스토랑 매출 분석 AI입니다.
한국어로 2~4문장 plain text 요약만 작성하세요. JSON, bullet, markdown 금지.
CONTEXT에 있는 숫자만 사용하세요.

질문: ${message}

CONTEXT:
${JSON.stringify(context)}`;
  }
  if (locale === 'fil') {
    return `You are a restaurant sales analyst. Write a 2-4 sentence plain text summary in Filipino (Tagalog) only. No JSON or bullets.
Use ONLY numbers from CONTEXT.

Question: ${message}

CONTEXT:
${JSON.stringify(context)}`;
  }
  return `You are a restaurant sales analyst. Write a 2-4 sentence plain text summary only. No JSON or bullets.
Use ONLY numbers from CONTEXT.

Question: ${message}

CONTEXT:
${JSON.stringify(context)}`;
}

function buildInstantPreviewLine({ cur, pctChange, period, locale }) {
  const pctSign = pctChange >= 0 ? '+' : '';
  if (locale === 'ko') {
    return `순매출 ₱${Math.round(cur.net_sales).toLocaleString()} (${pctSign}${pctChange}% vs 이전 기간). `;
  }
  if (locale === 'fil') {
    return `Net sales ₱${Math.round(cur.net_sales).toLocaleString()} (${pctSign}${pctChange}% vs nakaraang period). `;
  }
  return `Net sales ₱${Math.round(cur.net_sales).toLocaleString()} (${pctSign}${pctChange}% vs previous period). `;
}

function buildBriefInstantLine(ctx, locale) {
  const k = ctx.kpi;
  if (locale === 'ko') {
    return `순매출 ₱${Math.round(k.revenue_net_sales).toLocaleString()} · 비용 ₱${Math.round(k.expenses).toLocaleString()} · 순이익 ₱${Math.round(k.net_profit).toLocaleString()}. `;
  }
  if (locale === 'fil') {
    return `Net sales ₱${Math.round(k.revenue_net_sales).toLocaleString()} · Gastos ₱${Math.round(k.expenses).toLocaleString()} · Net profit ₱${Math.round(k.net_profit).toLocaleString()}. `;
  }
  return `Net sales ₱${Math.round(k.revenue_net_sales).toLocaleString()} · Expenses ₱${Math.round(k.expenses).toLocaleString()} · Net profit ₱${Math.round(k.net_profit).toLocaleString()}. `;
}

async function fetchAnalyticsChatData(focus, params, prevParams) {
  const needBranch = focus === 'branches' || focus === 'overview';
  const needMenu = focus === 'menu' || focus === 'overview';
  const needCategory = focus === 'category';
  const needPayment = focus === 'payment';

  const [dailyRes, dailyPrevRes, branchRes, menuRes, categoryRes, paymentRes] = await Promise.all([
    fetchPy('/api/analytics/daily-sales', params),
    fetchPy('/api/analytics/daily-sales', prevParams),
    needBranch
      ? fetchPy('/api/analytics/branch-sales', params).catch(() => ({ data: { data: [] } }))
      : Promise.resolve({ data: { data: [] } }),
    needMenu
      ? fetchPy('/api/analytics/menu-report', params)
      : Promise.resolve({ data: { data: [] } }),
    needCategory
      ? fetchPy('/api/analytics/category-report', params)
      : Promise.resolve({ data: { data: [] } }),
    needPayment
      ? fetchPy('/api/analytics/payment-report', params)
      : Promise.resolve({ data: { data: [] } }),
  ]);

  return { dailyRes, dailyPrevRes, branchRes, menuRes, categoryRes, paymentRes };
}

function chartTitles(locale) {
  const ko = String(locale || '').startsWith('ko');
  const fil = String(locale || '').startsWith('fil');
  if (ko) {
    return {
      dailyNet: '일별 순매출',
      byBranch: '지점별 매출',
      topMenu: '인기 메뉴 (순매출)',
      byCategory: '카테고리별 매출',
      payments: '결제 수단',
    };
  }
  if (fil) {
    return {
      dailyNet: 'Araw-araw na net sales',
      byBranch: 'Sales ayon sa branch',
      topMenu: 'Top menu (net sales)',
      byCategory: 'Sales ayon sa category',
      payments: 'Payment mix',
    };
  }
  return {
    dailyNet: 'Daily net sales',
    byBranch: 'Sales by branch',
    topMenu: 'Top menu (net sales)',
    byCategory: 'Sales by category',
    payments: 'Payments',
  };
}

function detectFocus(message) {
  const m = String(message || '').toLowerCase();
  if (/branch|sangay|store|compare branch|per branch|지점|매장/.test(m)) return 'branches';
  if (/category|kategorya|uri|카테고리|분류/.test(m)) return 'category';
  if (/payment|bayad|cash|card|gcash|mode|결제|지불/.test(m)) return 'payment';
  if (/trend|daily|araw|day|line|over time|추세|일별|매출 추이/.test(m)) return 'trend';
  if (/refund|discount|bawas|less|환불|할인/.test(m)) return 'overview';
  if (/menu|product|seller|mabenta|item|food|ulam|메뉴|상품|베스트/.test(m)) return 'menu';
  return 'overview';
}

function normalizeMessageForMatch(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.,"']/g, '')
    .replace(/\s+/g, ' ');
}

function hasAnalyticsIntent(message) {
  return /sales|menu|branch|trend|payment|category|revenue|net|discount|refund|compare|top|daily|overview|profit|expense|report|benta|bumili|trend|매출|메뉴|지점|추세|결제|카테고리|비용|이익|분석|performance|perform|selling|sold|araw|period|date/i.test(
    String(message || ''),
  );
}

function isConversationalMessage(message) {
  const raw = String(message || '').trim();
  const normalized = normalizeMessageForMatch(message);
  if (!normalized) return false;

  if (
    /^(hi|hello|hey|yo|sup|howdy|good morning|good afternoon|good evening|greetings|hi there|hello there)$/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /^(안녕|안녕하세요|안녕하십니까|반갑습니다|반가워요|반가워|하이|헬로)$/.test(normalized)
  ) {
    return true;
  }

  if (/^(kumusta|kamusta|musta|magandang umaga|magandang hapon|magandang gabi)$/.test(normalized)) {
    return true;
  }

  if (/^(thanks|thank you|thx|salamat|maraming salamat|감사합니다|고마워요|고마워|감사)$/.test(normalized)) {
    return true;
  }

  if (/^(bye|goodbye|see you|paalam|안녕히|잘 가|잘가)$/.test(normalized)) {
    return true;
  }

  if (
    /^(help|what can you do|what do you do|ano ang pwede|ano pwede|paano gumana|도움|도와줘|뭐 할 수|무엇을 할 수)/.test(
      normalized,
    )
  ) {
    return true;
  }

  const wordCount = normalized.split(' ').length;
  if (wordCount <= 2 && !hasAnalyticsIntent(normalized) && !/\d/.test(normalized)) {
    if (/^(ok|okay|nice|cool|great|yes|no|sure|test|testing|haha|lol|wow|네|예|응|ㅇㅇ|ㅋㅋ)$/.test(normalized)) {
      return true;
    }
  }

  if (hasHangul(raw) && !hasAnalyticsIntent(raw) && !/\d/.test(raw) && wordCount <= 3) {
    if (/^(안녕|반갑|고마워|감사|도움|하이|헬로|네|예|응|ㅇㅇ|ㅋㅋ)/.test(normalized)) {
      return true;
    }
  }

  return false;
}

function buildGreetingResponse(locale, period) {
  const ko = locale === 'ko';
  const fil = locale === 'fil';
  const normalized = normalizeMessageForMatch(period.message || '');

  let summary;
  if (/^(thanks|thank you|thx|salamat|maraming salamat|감사합니다|고마워)/.test(normalized)) {
    summary = ko
      ? '천만에요! 다른 매출 질문이 있으면 언제든 물어보세요.'
      : fil
        ? 'Walang anuman! Magtanong lang kung gusto mo ng sales insights.'
        : "You're welcome! Ask anytime if you need more sales insights.";
  } else if (/^(bye|goodbye|see you|paalam|안녕히|잘 가|잘가)$/.test(normalized)) {
    summary = ko
      ? '다음에 또 만나요! 매출 분석이 필요하면 언제든 질문해 주세요.'
      : fil
        ? 'Paalam! Balik lang kapag kailangan mo ng sales analysis.'
        : 'Goodbye! Come back anytime you need sales analysis.';
  } else if (/^(help|what can you do|what do you do|ano ang pwede|ano pwede|paano gumana|도움|도와줘|뭐 할 수|무엇을 할 수)/.test(normalized)) {
    summary = ko
      ? `저는 ${period.start}~${period.end} 기간 매출 데이터를 분석하는 AI입니다. 매출 개요, 인기 메뉴, 지점 비교, 추세 등을 질문해 보세요.`
      : fil
        ? `AI sales assistant ako para sa period ${period.start}–${period.end}. Puwede mong itanong ang sales overview, top menu, branch comparison, trends, at iba pa.`
        : `I'm an AI sales assistant for ${period.start}–${period.end}. Ask about sales overview, top menu, branch comparison, trends, payments, and more.`;
  } else {
    summary = ko
      ? `안녕하세요! ${period.start}~${period.end} 기간 매출 데이터를 바탕으로 질문에 답해 드립니다.`
      : fil
        ? `Kumusta! Puwede kitang tulungan sa sales, menu, branches, at trends para sa period ${period.start}–${period.end}.`
        : `Hello! I can help with sales, menu performance, branches, and trends for ${period.start}–${period.end}.`;
  }

  const bullets = ko
    ? ['매출 개요, 인기 메뉴, 지점 비교 등을 물어보세요.', '아래 추천 질문을 눌러 빠르게 시작할 수 있습니다.']
    : fil
      ? ['Magtanong tungkol sa sales overview, top menu, o branch comparison.', 'Pindutin ang mga suggested question sa ibaba para magsimula.']
      : ['Ask about sales overview, top menu, branch comparison, and more.', 'Use the suggestion chips below to get started quickly.'];

  const suggestedReplies = ko
    ? ['이번 기간 매출 개요', '인기 메뉴 TOP', '지점별 매출 비교', '일별 매출 추세']
    : fil
      ? ['Sales overview ng period na ito', 'Top selling menu items', 'Compare sales by branch', 'Daily sales trend']
      : ['Sales overview for this period', 'Top selling menu items', 'Compare sales by branch', 'Daily sales trend'];

  return {
    summary,
    bullets,
    suggestedReplies,
    charts: [],
    contextMeta: { focus: 'greeting', period: { start: period.start, end: period.end }, locale },
  };
}

function buildCharts(focus, { dailyCurrent, dailyPrevious, branchRows, menuTop, categoryRows, paymentRows, locale }) {
  const charts = [];
  const cur = sumDaily(dailyCurrent);
  const prev = sumDaily(dailyPrevious);
  const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : 100) : Math.round(((a - b) / b) * 1000) / 10);
  const titles = chartTitles(locale);
  const ko = String(locale || '').startsWith('ko');
  const netLabel = ko ? '순매출' : 'Net sales';
  const totalLabel = ko ? '총매출' : 'Total sales';
  const amountLabel = ko ? '금액' : 'Amount';

  if (focus === 'trend' || focus === 'overview') {
    const labels = (dailyCurrent || []).slice(-14).map((d) => String(d.sale_date).slice(5));
    const data = (dailyCurrent || []).slice(-14).map((d) => {
      const total = Number(d.total_sales) || 0;
      const refund = Number(d.refund) || 0;
      const discount = Number(d.discount) || 0;
      return Number(d.net_sales) || total - refund - discount;
    });
    if (labels.length > 0) {
      charts.push({
        type: 'line',
        title: titles.dailyNet,
        labels,
        series: [{ name: netLabel, data }],
      });
    }
  }

  if (focus === 'branches' && (branchRows || []).length > 0) {
    const sorted = [...branchRows].sort((a, b) => (Number(b.total_sales) || 0) - (Number(a.total_sales) || 0));
    charts.push({
      type: 'bar',
      title: titles.byBranch,
      labels: sorted.map((b) => String(b.branch_name || b.branch_code || b.branch_id)),
      series: [{ name: totalLabel, data: sorted.map((b) => Number(b.total_sales) || 0) }],
    });
  }

  if ((focus === 'menu' || focus === 'overview') && menuTop.length > 0) {
    charts.push({
      type: 'bar',
      title: titles.topMenu,
      labels: menuTop.map((x) => x.name),
      series: [{ name: netLabel, data: menuTop.map((x) => x.netSales) }],
    });
  }

  if (focus === 'category' && (categoryRows || []).length > 0) {
    const sorted = [...categoryRows].sort(
      (a, b) => (Number(b.netSales) || Number(b.totalSales) || 0) - (Number(a.netSales) || Number(a.totalSales) || 0),
    );
    charts.push({
      type: 'bar',
      title: titles.byCategory,
      labels: sorted.slice(0, 10).map((c) => String(c.category || c.name || '—')),
      series: [
        {
          name: netLabel,
          data: sorted.slice(0, 10).map((c) => Number(c.netSales) || Number(c.totalSales) || 0),
        },
      ],
    });
  }

  if (focus === 'payment' && (paymentRows || []).length > 0) {
    charts.push({
      type: 'bar',
      title: titles.payments,
      labels: paymentRows.map((p) => String(p.paymentType || p.payment_type || '—')),
      series: [{ name: amountLabel, data: paymentRows.map((p) => Number(p.paymentAmount) || Number(p.amount) || 0) }],
    });
  }

  if (charts.length === 0 && menuTop.length > 0) {
    charts.push({
      type: 'bar',
      title: titles.topMenu,
      labels: menuTop.map((x) => x.name),
      series: [{ name: netLabel, data: menuTop.map((x) => x.netSales) }],
    });
  }

  return { charts, cur, prev, pctChange: pct(cur.net_sales, prev.net_sales) };
}

function stripMarkdownCodeFences(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^\s*```(?:json|JSON)?\s*\r?\n?/i, '');
  s = s.replace(/\r?\n?\s*```\s*$/i, '');
  return s.trim();
}

function extractJsonObject(text) {
  const s = String(text ?? '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  return s.slice(first, last + 1);
}

function parseModelJson(rawText) {
  const s = stripMarkdownCodeFences(rawText);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const slice = extractJsonObject(s);
    if (!slice) return null;
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }
}

function buildAnalyticsResponseSchema(SchemaType) {
  return {
    type: SchemaType.OBJECT,
    properties: {
      summary: { type: SchemaType.STRING },
      bullets: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      suggestedReplies: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    },
    required: ['summary', 'bullets', 'suggestedReplies'],
  };
}

function buildManagementBriefResponseSchema(SchemaType) {
  return {
    type: SchemaType.OBJECT,
    properties: {
      executive_summary: { type: SchemaType.STRING },
      sales_analysis: { type: SchemaType.STRING },
      expense_analysis: { type: SchemaType.STRING },
      recommendations: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      suggestedReplies: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    },
    required: ['executive_summary', 'sales_analysis', 'expense_analysis', 'recommendations', 'suggestedReplies'],
  };
}

async function getVertexSdk() {
  if (!vertexSdkPromise) {
    vertexSdkPromise = import('@google-cloud/vertexai');
  }
  return vertexSdkPromise;
}

function getVertexClient(VertexAI, location) {
  if (!vertexClients.has(location)) {
    vertexClients.set(location, new VertexAI({ project: VERTEX_PROJECT_ID, location }));
  }
  return vertexClients.get(location);
}

function vertexAttemptOrder() {
  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  const attempts = [];
  if (provenVertexModel) {
    attempts.push(provenVertexModel);
  }
  for (const location of locationOrder) {
    for (const modelId of MODEL_CANDIDATES) {
      const dup = attempts.some((a) => a.location === location && a.modelId === modelId);
      if (!dup) attempts.push({ location, modelId });
    }
  }
  return attempts;
}

async function vertexGenerateJson(prompt, opts = {}) {
  const schemaBuilder = opts.schemaBuilder || buildAnalyticsResponseSchema;
  const maxOutputTokens = opts.maxOutputTokens ?? 1024;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }
  const { VertexAI, SchemaType } = await getVertexSdk();
  const attempts = vertexAttemptOrder();

  let lastErr = null;
  const t0 = Date.now();
  for (const { location, modelId } of attempts) {
    const vertex = getVertexClient(VertexAI, location);
    try {
      const model = vertex.getGenerativeModel({
        model: modelId,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: schemaBuilder(SchemaType),
        },
      });
      const resp = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      const text =
        resp?.response?.candidates?.[0]?.content?.parts
          ?.map((p) => p?.text)
          .filter(Boolean)
          .join('\n') ?? '';
      if (!text) throw new Error('Empty Vertex response');
      provenVertexModel = { location, modelId };
      logTiming(`Vertex ${modelId}@${location}`, Date.now() - t0);
      return text;
    } catch (e) {
      lastErr = e;
      if (!/404|NOT_FOUND|not found|Publisher Model/i.test(String(e?.message ?? e))) throw e;
    }
  }
  throw lastErr || new Error('Vertex generation failed');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

async function vertexGeneratePlainStream(prompt, onAccumulated, signal, maxOutputTokens = 1024) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }
  const { VertexAI } = await import('@google-cloud/vertexai');
  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  let lastErr = null;
  for (const location of locationOrder) {
    throwIfAborted(signal);
    const vertex = new VertexAI({ project: VERTEX_PROJECT_ID, location });
    for (const modelId of MODEL_CANDIDATES) {
      try {
        const model = vertex.getGenerativeModel({
          model: modelId,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
          },
        });
        const streamingResp = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        let fullText = '';
        for await (const item of streamingResp.stream) {
          throwIfAborted(signal);
          const chunk =
            item?.candidates?.[0]?.content?.parts
              ?.map((p) => p?.text)
              .filter(Boolean)
              .join('') ?? '';
          if (!chunk) continue;
          fullText += chunk;
          await onAccumulated(fullText);
        }

        if (!fullText.trim()) throw new Error('Empty Vertex plain stream response');
        return fullText.trim();
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        if (!/404|NOT_FOUND|not found|Publisher Model/i.test(String(e?.message ?? e))) throw e;
      }
    }
  }
  throw lastErr || new Error('Vertex plain stream generation failed');
}

async function vertexGenerateJsonStream(prompt, opts, onAccumulated, signal) {
  const schemaBuilder = opts.schemaBuilder || buildAnalyticsResponseSchema;
  const maxOutputTokens = opts.maxOutputTokens ?? 2048;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }
  const { VertexAI, SchemaType } = await import('@google-cloud/vertexai');
  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  let lastErr = null;
  for (const location of locationOrder) {
    throwIfAborted(signal);
    const vertex = new VertexAI({ project: VERTEX_PROJECT_ID, location });
    for (const modelId of MODEL_CANDIDATES) {
      try {
        const model = vertex.getGenerativeModel({
          model: modelId,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: schemaBuilder(SchemaType),
          },
        });
        const streamingResp = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        let fullText = '';
        for await (const item of streamingResp.stream) {
          throwIfAborted(signal);
          const chunk =
            item?.candidates?.[0]?.content?.parts
              ?.map((p) => p?.text)
              .filter(Boolean)
              .join('') ?? '';
          if (!chunk) continue;
          fullText += chunk;
          await onAccumulated(fullText);
        }

        if (!fullText) throw new Error('Empty Vertex stream response');
        return fullText;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        if (!/404|NOT_FOUND|not found|Publisher Model/i.test(String(e?.message ?? e))) throw e;
      }
    }
  }
  throw lastErr || new Error('Vertex stream generation failed');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

async function vertexGeneratePlainStream(prompt, onAccumulated, signal, maxOutputTokens = 1024) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }
  const { VertexAI } = await import('@google-cloud/vertexai');
  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  let lastErr = null;
  for (const location of locationOrder) {
    throwIfAborted(signal);
    const vertex = new VertexAI({ project: VERTEX_PROJECT_ID, location });
    for (const modelId of MODEL_CANDIDATES) {
      try {
        const model = vertex.getGenerativeModel({
          model: modelId,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
          },
        });
        const streamingResp = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        let fullText = '';
        for await (const item of streamingResp.stream) {
          throwIfAborted(signal);
          const chunk =
            item?.candidates?.[0]?.content?.parts
              ?.map((p) => p?.text)
              .filter(Boolean)
              .join('') ?? '';
          if (!chunk) continue;
          fullText += chunk;
          await onAccumulated(fullText);
        }

        if (!fullText.trim()) throw new Error('Empty Vertex plain stream response');
        return fullText.trim();
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        if (!/404|NOT_FOUND|not found|Publisher Model/i.test(String(e?.message ?? e))) throw e;
      }
    }
  }
  throw lastErr || new Error('Vertex plain stream generation failed');
}

async function vertexGenerateJsonStream(prompt, opts, onAccumulated, signal) {
  const schemaBuilder = opts.schemaBuilder || buildAnalyticsResponseSchema;
  const maxOutputTokens = opts.maxOutputTokens ?? 2048;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }
  const { VertexAI, SchemaType } = await import('@google-cloud/vertexai');
  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  let lastErr = null;
  for (const location of locationOrder) {
    throwIfAborted(signal);
    const vertex = new VertexAI({ project: VERTEX_PROJECT_ID, location });
    for (const modelId of MODEL_CANDIDATES) {
      try {
        const model = vertex.getGenerativeModel({
          model: modelId,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: schemaBuilder(SchemaType),
          },
        });
        const streamingResp = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        let fullText = '';
        for await (const item of streamingResp.stream) {
          throwIfAborted(signal);
          const chunk =
            item?.candidates?.[0]?.content?.parts
              ?.map((p) => p?.text)
              .filter(Boolean)
              .join('') ?? '';
          if (!chunk) continue;
          fullText += chunk;
          await onAccumulated(fullText);
        }

        if (!fullText) throw new Error('Empty Vertex stream response');
        return fullText;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        if (!/404|NOT_FOUND|not found|Publisher Model/i.test(String(e?.message ?? e))) throw e;
      }
    }
  }
  throw lastErr || new Error('Vertex stream generation failed');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

async function vertexGeneratePlainStream(prompt, onAccumulated, signal, maxOutputTokens = 1024) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }
  const { VertexAI } = await import('@google-cloud/vertexai');
  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  let lastErr = null;
  for (const location of locationOrder) {
    throwIfAborted(signal);
    const vertex = new VertexAI({ project: VERTEX_PROJECT_ID, location });
    for (const modelId of MODEL_CANDIDATES) {
      try {
        const model = vertex.getGenerativeModel({
          model: modelId,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
          },
        });
        const streamingResp = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        let fullText = '';
        for await (const item of streamingResp.stream) {
          throwIfAborted(signal);
          const chunk =
            item?.candidates?.[0]?.content?.parts
              ?.map((p) => p?.text)
              .filter(Boolean)
              .join('') ?? '';
          if (!chunk) continue;
          fullText += chunk;
          await onAccumulated(fullText);
        }

        if (!fullText.trim()) throw new Error('Empty Vertex plain stream response');
        return fullText.trim();
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        if (!/404|NOT_FOUND|not found|Publisher Model/i.test(String(e?.message ?? e))) throw e;
      }
    }
  }
  throw lastErr || new Error('Vertex plain stream generation failed');
}

async function vertexGenerateJsonStream(prompt, opts, onAccumulated, signal) {
  const schemaBuilder = opts.schemaBuilder || buildAnalyticsResponseSchema;
  const maxOutputTokens = opts.maxOutputTokens ?? 2048;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_KEY_PATH;
  }
  const { VertexAI, SchemaType } = await import('@google-cloud/vertexai');
  const locationOrder =
    process.env.VERTEX_LOCATION && String(process.env.VERTEX_LOCATION).trim()
      ? [String(process.env.VERTEX_LOCATION).trim()]
      : [VERTEX_LOCATION_PRIMARY, VERTEX_LOCATION_FALLBACK].filter((loc, i, arr) => arr.indexOf(loc) === i);

  let lastErr = null;
  for (const location of locationOrder) {
    throwIfAborted(signal);
    const vertex = new VertexAI({ project: VERTEX_PROJECT_ID, location });
    for (const modelId of MODEL_CANDIDATES) {
      try {
        const model = vertex.getGenerativeModel({
          model: modelId,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: schemaBuilder(SchemaType),
          },
        });
        const streamingResp = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        let fullText = '';
        for await (const item of streamingResp.stream) {
          throwIfAborted(signal);
          const chunk =
            item?.candidates?.[0]?.content?.parts
              ?.map((p) => p?.text)
              .filter(Boolean)
              .join('') ?? '';
          if (!chunk) continue;
          fullText += chunk;
          await onAccumulated(fullText);
        }

        if (!fullText) throw new Error('Empty Vertex stream response');
        return fullText;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        lastErr = e;
        if (!/404|NOT_FOUND|not found|Publisher Model/i.test(String(e?.message ?? e))) throw e;
      }
    }
  }
  throw lastErr || new Error('Vertex stream generation failed');
}

function fallbackNarrative({ cur, prev, pctChange, menuTop, branchRows, period, locale }) {
  const loc = String(locale || 'en').toLowerCase();
  const fil = loc.startsWith('fil');
  const ko = loc.startsWith('ko');
  const summary = ko
    ? `${period.start}~${period.end} 기간 순매출: ₱${cur.net_sales.toLocaleString()}. 이전 기간 대비 ${Math.abs(pctChange)}% ${pctChange >= 0 ? '증가' : '감소'}.`
    : fil
      ? `Net sales sa period ${period.start}–${period.end}: ₱${cur.net_sales.toLocaleString()}. ${pctChange >= 0 ? 'Tumaas' : 'Bumaba'} ng ${Math.abs(pctChange)}% vs nakaraang period.`
      : `Net sales for ${period.start}–${period.end}: ₱${cur.net_sales.toLocaleString()}. ${pctChange >= 0 ? 'Up' : 'Down'} ${Math.abs(pctChange)}% vs previous period.`;
  const bullets = [];
  if (menuTop[0]) {
    bullets.push(
      ko
        ? `최다 판매 메뉴: ${menuTop[0].name} (순매출 ₱${menuTop[0].netSales.toLocaleString()}).`
        : fil
          ? `Pinakamabentang item: ${menuTop[0].name} (₱${menuTop[0].netSales.toLocaleString()} net).`
          : `Top item: ${menuTop[0].name} (₱${menuTop[0].netSales.toLocaleString()} net).`,
    );
  }
  if ((branchRows || []).length > 1) {
    const top = [...branchRows].sort((a, b) => (Number(b.total_sales) || 0) - (Number(a.total_sales) || 0))[0];
    if (top) {
      bullets.push(
        ko
          ? `최고 매출 지점: ${top.branch_name} (₱${Number(top.total_sales).toLocaleString()}).`
          : fil
            ? `Pinakamataas na branch: ${top.branch_name} (₱${Number(top.total_sales).toLocaleString()}).`
            : `Top branch: ${top.branch_name} (₱${Number(top.total_sales).toLocaleString()}).`,
      );
    }
  }
  bullets.push(
    ko
      ? `환불: ₱${cur.refund.toLocaleString()}, 할인: ₱${cur.discount.toLocaleString()}.`
      : fil
        ? `Refund: ₱${cur.refund.toLocaleString()}, discount: ₱${cur.discount.toLocaleString()}.`
        : `Refunds: ₱${cur.refund.toLocaleString()}, discounts: ₱${cur.discount.toLocaleString()}.`,
  );
  return {
    summary,
    bullets,
    suggestedReplies: ko
      ? ['인기 메뉴 TOP 10', '지점별 매출 비교', '일별 매출 추세', '결제 수단']
      : fil
        ? ['Top 10 menu', 'Compare branches', 'Daily trend', 'Payment mix']
        : ['Top 10 menu', 'Compare branches', 'Daily trend', 'Payment mix'],
  };
}

/**
 * @param {{ message: string, start_date: string, end_date: string, locale?: string, history?: Array<{ role: string, content: string }> }} input
 */
async function runAnalyticsChat(input) {
  const message = String(input.message || '').trim();
  const start_date = String(input.start_date || '').trim();
  const end_date = String(input.end_date || '').trim();
  const locale = resolveResponseLocale(input.locale, message);
  const history = sanitizeChatHistory(input.history);
  if (!message) throw new Error('Message is required');
  if (!start_date || !end_date) throw new Error('start_date and end_date are required');

  if (isConversationalMessage(message)) {
    return buildGreetingResponse(locale, { start: start_date, end: end_date, message });
  }

  const prev = previousPeriod(start_date, end_date);
  const focus = detectFocus(message);
  const params = { start_date, end_date };
  const prevParams = { start_date: prev.start, end_date: prev.end };
  const needsBranches = focus === 'branches' || focus === 'overview';
  const needsMenu = focus === 'menu' || focus === 'overview' || focus === 'trend';
  const needsCategory = focus === 'category';
  const needsPayment = focus === 'payment';

  const tFetch = Date.now();
  const [dailyRes, dailyPrevRes, branchRes, menuRes, categoryRes, paymentRes] = await Promise.all([
    fetchPyCached('/api/analytics/daily-sales', params),
    fetchPyCached('/api/analytics/daily-sales', prevParams),
    needsBranches
      ? fetchPyCached('/api/analytics/branch-sales', params).catch(() => ({ data: { data: [] } }))
      : Promise.resolve({ data: { data: [] } }),
    needsMenu
      ? fetchPyCached('/api/analytics/menu-report', params)
      : Promise.resolve({ data: { data: [] } }),
    needsCategory
      ? fetchPyCached('/api/analytics/category-report', params)
      : Promise.resolve({ data: { data: [] } }),
    needsPayment
      ? fetchPyCached('/api/analytics/payment-report', params)
      : Promise.resolve({ data: { data: [] } }),
  ]);
  logTiming('PyServer fetch', Date.now() - tFetch);

  const dailyCurrent = dailyRes?.data?.data || [];
  const dailyPrevious = dailyPrevRes?.data?.data || [];
  const branchRows = branchRes?.data?.data || [];
  const menuRows = menuRes?.data?.data || [];
  const categoryRows = categoryRes?.data?.data || [];
  const paymentRows = paymentRes?.data?.data || [];
  const menuTop = topMenuByNet(menuRows, 10);

  const { charts, cur, prev: prevTotals, pctChange } = buildCharts(focus, {
    dailyCurrent,
    dailyPrevious,
    branchRows,
    menuTop,
    categoryRows,
    paymentRows,
    locale,
  });

  const context = {
    period: { start: start_date, end: end_date },
    previous_period: prev,
    focus,
    totals_current: cur,
    totals_previous: prevTotals,
    net_sales_pct_change: pctChange,
    top_menu: menuTop,
    branches: (branchRows || []).slice(0, 12).map((b) => ({
      name: b.branch_name,
      total_sales: Number(b.total_sales) || 0,
      orders: Number(b.order_count) || 0,
    })),
    categories: (categoryRows || []).slice(0, 10),
    payments: (paymentRows || []).slice(0, 8),
  };

  const fallbackPayload = {
    cur,
    prev: prevTotals,
    pctChange,
    menuTop,
    branchRows,
    period: { start: start_date, end: end_date },
    locale,
  };

  let narrative;
  try {
    const prompt = buildAnalyticsPrompt(locale, message, context, history);
    let raw = await vertexGenerateJson(prompt);
    let parsed = parseModelJson(raw);
    narrative = parseNarrativeFromModel(parsed);

    if (!narrativeMatchesLocale(narrative, locale) && locale === 'ko') {
      console.warn('[AnalyticsAI] Model reply wrong language, retrying once. locale=', locale);
      const retryPrompt =
        locale === 'ko'
          ? `${prompt}\n\n이전 응답이 영어였습니다. 이번에는 summary, bullets, suggestedReplies 전부 한국어로만 다시 작성하세요.`
          : `${prompt}\n\nYour previous reply used the wrong language. Rewrite entirely in the required language.`;
      raw = await vertexGenerateJson(retryPrompt);
      parsed = parseModelJson(raw);
      narrative = parseNarrativeFromModel(parsed);
    }
  } catch (err) {
    console.warn('[AnalyticsAI] Vertex failed, using fallback:', err?.message || err);
    narrative = fallbackNarrative(fallbackPayload);
  }

  if (!narrative.summary || !narrativeMatchesLocale(narrative, locale)) {
    narrative = fallbackNarrative(fallbackPayload);
  }

  return {
    ...narrative,
    charts,
    contextMeta: { focus, period: { start: start_date, end: end_date }, locale },
  };
}

function compactManagementContext(ctx) {
  return {
    period: ctx.period,
    previous_period: ctx.previous_period,
    kpi: ctx.kpi,
    kpi_previous: ctx.kpi_previous,
    comparisons: ctx.comparisons,
    sales_breakdown: ctx.sales_breakdown,
    expense_breakdown: ctx.expense_breakdown,
    context: ctx.context,
  };
}

function buildManagementBriefPrompt(locale, context) {
  const langRule =
    locale === 'ko'
      ? '모든 섹션은 반드시 한국어로 작성하세요. 영어 문장을 사용하지 마세요.'
      : locale === 'fil'
        ? 'Write all sections in Filipino (Tagalog).'
        : 'Write all sections in English.';

  return `You are a management consultant specializing in F&B with 20 years of experience.
${langRule}

Analyze MANAGEMENT_CONTEXT (JSON) and write a narrative report management can understand intuitively.

Rules:
- Use ONLY figures from MANAGEMENT_CONTEXT. Do not invent numbers or industry percentiles.
- Do not merely list every figure; explain WHY changes happened and WHAT TO DO next.
- Mention one-time costs or seasonality only if supported by context notes or obvious expense spikes.
- If data_gaps say a metric is unavailable, do not claim it.
- executive_summary: 2-4 sentences covering revenue, expenses, net profit, and period comparison.
- sales_analysis: 2-4 sentences on drivers (menu, category, branch, drinks if relevant).
- expense_analysis: 2-4 sentences on expense trend and main cost items.
- recommendations: 3-5 actionable strategies for marketing/operations.
- suggestedReplies: 3-4 short follow-up questions the CEO might ask.

MANAGEMENT_CONTEXT:
${JSON.stringify(compactManagementContext(context))}

Return JSON only with keys: executive_summary, sales_analysis, expense_analysis, recommendations, suggestedReplies.`;
}

function parseBriefFromModel(parsed) {
  return {
    executive_summary: String(parsed?.executive_summary || '').trim(),
    sales_analysis: String(parsed?.sales_analysis || '').trim(),
    expense_analysis: String(parsed?.expense_analysis || '').trim(),
    recommendations: Array.isArray(parsed?.recommendations)
      ? parsed.recommendations.map((r) => String(r).trim()).filter(Boolean).slice(0, 6)
      : [],
    suggestedReplies: Array.isArray(parsed?.suggestedReplies)
      ? parsed.suggestedReplies.map((s) => String(s).trim()).filter(Boolean).slice(0, 4)
      : [],
  };
}

function briefMatchesLocale(brief, locale) {
  const combined = [
    brief.executive_summary,
    brief.sales_analysis,
    brief.expense_analysis,
    ...(brief.recommendations || []),
  ].join(' ');
  if (!brief.executive_summary) return false;
  if (locale === 'ko') return hasHangul(combined);
  return true;
}

function fallbackManagementBrief(ctx, locale) {
  const k = ctx.kpi;
  const c = ctx.comparisons;
  const ko = locale === 'ko';
  const fil = locale === 'fil';
  const rev = k.revenue_net_sales;
  const exp = k.expenses;
  const profit = k.net_profit;

  const executive_summary = ko
    ? `${ctx.period.start}~${ctx.period.end} 기간 순매출 ₱${rev.toLocaleString()}, 비용 ₱${exp.toLocaleString()}, 순이익 ₱${profit.toLocaleString()}입니다. 순매출은 이전 기간 대비 ${c.revenue_net_sales_pct}%, 순이익은 ${c.net_profit_pct}% 변동했습니다.`
    : fil
      ? `Sa period ${ctx.period.start}–${ctx.period.end}, net sales ₱${rev.toLocaleString()}, gastos ₱${exp.toLocaleString()}, net profit ₱${profit.toLocaleString()}. Net sales ${c.revenue_net_sales_pct}% vs nakaraang period; net profit ${c.net_profit_pct}%.`
      : `For ${ctx.period.label}, net sales were ₱${rev.toLocaleString()}, expenses ₱${exp.toLocaleString()}, and net profit ₱${profit.toLocaleString()}. Net sales changed ${c.revenue_net_sales_pct}% vs the previous period; net profit changed ${c.net_profit_pct}%.`;

  const topMenu = ctx.sales_breakdown?.top_menu?.[0];
  const topCat = ctx.sales_breakdown?.top_categories?.[0];
  const sales_analysis = ko
    ? `매출은 ${topCat ? `${topCat.name} 카테고리` : '주요 카테고리'}와 ${topMenu ? topMenu.name : '상위 메뉴'} 중심으로 형성되었습니다.`
    : topMenu || topCat
      ? `Sales were led by ${topCat ? `category "${topCat.name}"` : 'top categories'} and menu item "${topMenu?.name || '—'}".`
      : 'Review category and menu reports for sales drivers.';

  const topExp = ctx.expense_breakdown?.items?.[0];
  const expense_analysis = ko
    ? `비용은 총 ₱${exp.toLocaleString()}으로 이전 대비 ${c.expenses_pct}% 변동했습니다.${topExp ? ` 주요 항목: ${topExp.name}.` : ''}`
    : `Expenses totaled ₱${exp.toLocaleString()} (${c.expenses_pct}% vs previous period).${topExp ? ` Largest item: ${topExp.name}.` : ''}`;

  const recommendations = ko
    ? ['인기 메뉴·카테고리 중심 프로모션 검토', '비용 상위 항목 월별 모니터링', '지점별 매출 격차 분석']
    : fil
      ? ['Palakasin ang promo sa top menu/category', 'Monitor ang pinakamalaking gastos', 'Suriin ang sales per branch']
      : ['Strengthen promotions around top menu/category performers', 'Monitor top expense lines monthly', 'Review branch sales gaps'];

  return {
    executive_summary,
    sales_analysis,
    expense_analysis,
    recommendations,
    suggestedReplies: ko
      ? ['지점별 매출 비교', '주류 카테고리 추세', '비용 항목 상세']
      : ['Compare branches', 'Drinks category trend', 'Expense detail by category'],
  };
}

/**
 * @param {{ start_date: string, end_date: string, locale?: string }} input
 */
async function runManagementBrief(input) {
  const start_date = String(input.start_date || '').trim();
  const end_date = String(input.end_date || '').trim();
  const locale = resolveResponseLocale(input.locale, '');
  if (!start_date || !end_date) throw new Error('start_date and end_date are required');

  const ctx = await buildManagementContext(start_date, end_date);
  const charts = buildManagementBriefCharts(ctx, locale);

  let brief;
  try {
    const prompt = buildManagementBriefPrompt(locale, ctx);
    let raw = await vertexGenerateJson(prompt, {
      schemaBuilder: buildManagementBriefResponseSchema,
      maxOutputTokens: 2048,
    });
    let parsed = parseModelJson(raw);
    brief = parseBriefFromModel(parsed);

    if (!briefMatchesLocale(brief, locale) && locale === 'ko') {
      const retryPrompt =
        locale === 'ko'
          ? `${prompt}\n\n이전 응답이 영어였습니다. executive_summary, sales_analysis, expense_analysis, recommendations, suggestedReplies 전부 한국어로 다시 작성하세요.`
          : `${prompt}\n\nRewrite entirely in the required language.`;
      raw = await vertexGenerateJson(retryPrompt, {
        schemaBuilder: buildManagementBriefResponseSchema,
        maxOutputTokens: 2048,
      });
      parsed = parseModelJson(raw);
      brief = parseBriefFromModel(parsed);
    }
  } catch (err) {
    console.warn('[AnalyticsAI] Management brief Vertex failed:', err?.message || err);
    brief = fallbackManagementBrief(ctx, locale);
  }

  if (!brief.executive_summary || !briefMatchesLocale(brief, locale)) {
    brief = fallbackManagementBrief(ctx, locale);
  }

  const summary = [brief.executive_summary, brief.sales_analysis, brief.expense_analysis]
    .filter(Boolean)
    .join('\n\n');

  return {
    mode: 'management_brief',
    executive_summary: brief.executive_summary,
    sales_analysis: brief.sales_analysis,
    expense_analysis: brief.expense_analysis,
    recommendations: brief.recommendations,
    suggestedReplies: brief.suggestedReplies,
    summary,
    bullets: brief.recommendations,
    charts,
    contextMeta: {
      mode: 'management_brief',
      period: { start: start_date, end: end_date },
      locale,
      kpi: ctx.kpi,
      comparisons: ctx.comparisons,
    },
  };
}

/**
 * @param {{ message: string, start_date: string, end_date: string, locale?: string }} input
 * @param {{ send: (event: string, data: unknown) => void, signal?: AbortSignal }} io
 */
async function runAnalyticsChatStream(input, io) {
  const send = io.send;
  const signal = io.signal;
  const message = String(input.message || '').trim();
  const start_date = String(input.start_date || '').trim();
  const end_date = String(input.end_date || '').trim();
  const locale = resolveResponseLocale(input.locale, message);
  if (!message) throw new Error('Message is required');
  if (!start_date || !end_date) throw new Error('start_date and end_date are required');

  throwIfAborted(signal);
  send('status', { phase: 'preparing' });

  if (isConversationalMessage(message)) {
    const greeting = buildGreetingResponse(locale, { start: start_date, end: end_date, message });
    send('meta', { charts: greeting.charts || [] });
    send('delta', { mode: 'chat', summary: greeting.summary });
    send('done', { data: greeting });
    return;
  }

  const prev = previousPeriod(start_date, end_date);
  const focus = detectFocus(message);
  const params = { start_date, end_date };
  const prevParams = { start_date: prev.start, end_date: prev.end };

  const { dailyRes, dailyPrevRes, branchRes, menuRes, categoryRes, paymentRes } =
    await fetchAnalyticsChatData(focus, params, prevParams);

  throwIfAborted(signal);

  const dailyCurrent = dailyRes?.data?.data || [];
  const dailyPrevious = dailyPrevRes?.data?.data || [];
  const branchRows = branchRes?.data?.data || [];
  const menuRows = menuRes?.data?.data || [];
  const categoryRows = categoryRes?.data?.data || [];
  const paymentRows = paymentRes?.data?.data || [];
  const menuTop = topMenuByNet(menuRows, 10);

  const { charts, cur, prev: prevTotals, pctChange } = buildCharts(focus, {
    dailyCurrent,
    dailyPrevious,
    branchRows,
    menuTop,
    categoryRows,
    paymentRows,
    locale,
  });

  send('meta', { charts, focus, mode: 'chat' });
  send('status', { phase: 'generating' });
  send('delta', {
    mode: 'chat',
    summary: buildInstantPreviewLine({
      cur,
      pctChange,
      period: { start: start_date, end: end_date },
      locale,
    }),
  });

  const context = {
    period: { start: start_date, end: end_date },
    previous_period: prev,
    focus,
    totals_current: cur,
    totals_previous: prevTotals,
    net_sales_pct_change: pctChange,
    top_menu: menuTop,
    branches: (branchRows || []).slice(0, 12).map((b) => ({
      name: b.branch_name,
      total_sales: Number(b.total_sales) || 0,
      orders: Number(b.order_count) || 0,
    })),
    categories: (categoryRows || []).slice(0, 10),
    payments: (paymentRows || []).slice(0, 8),
  };

  const fallbackPayload = {
    cur,
    prev: prevTotals,
    pctChange,
    menuTop,
    branchRows,
    period: { start: start_date, end: end_date },
    locale,
  };

  const streamPrompt = buildAnalyticsPlainStreamPrompt(locale, message, context);
  let narrative;

  try {
    const summary = await vertexGeneratePlainStream(
      streamPrompt,
      (accumulated) => {
        send('delta', { mode: 'chat', summary: accumulated.trim() });
      },
      signal,
    );
    const fallback = fallbackNarrative(fallbackPayload);
    narrative = {
      summary,
      bullets: fallback.bullets,
      suggestedReplies: fallback.suggestedReplies,
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn('[AnalyticsAI] Vertex plain stream failed, using fallback:', err?.message || err);
    narrative = fallbackNarrative(fallbackPayload);
    send('delta', { mode: 'chat', summary: narrative.summary });
  }

  if (!narrative.summary || !narrativeMatchesLocale(narrative, locale)) {
    narrative = fallbackNarrative(fallbackPayload);
    send('delta', { mode: 'chat', summary: narrative.summary });
  }

  send('done', {
    data: {
      ...narrative,
      charts,
      contextMeta: { focus, period: { start: start_date, end: end_date }, locale },
    },
  });
}

/**
 * @param {{ start_date: string, end_date: string, locale?: string }} input
 * @param {{ send: (event: string, data: unknown) => void, signal?: AbortSignal }} io
 */
async function runManagementBriefStream(input, io) {
  const send = io.send;
  const signal = io.signal;
  const start_date = String(input.start_date || '').trim();
  const end_date = String(input.end_date || '').trim();
  const locale = resolveResponseLocale(input.locale, '');
  if (!start_date || !end_date) throw new Error('start_date and end_date are required');

  throwIfAborted(signal);
  send('status', { phase: 'preparing' });

  const ctx = await buildManagementContext(start_date, end_date);
  const charts = buildManagementBriefCharts(ctx, locale);

  throwIfAborted(signal);
  send('meta', { charts, mode: 'management_brief' });
  send('status', { phase: 'generating' });
  send('delta', {
    mode: 'management_brief',
    executive_summary: buildBriefInstantLine(ctx, locale),
  });

  const prompt = buildManagementBriefPrompt(locale, ctx);
  const lastDeltaRef = { value: '' };
  let brief;

  try {
    const raw = await vertexGenerateJsonStream(
      prompt,
      {
        schemaBuilder: buildManagementBriefResponseSchema,
        maxOutputTokens: 4096,
      },
      (accumulated) => {
        sendStreamDeltaIfChanged(send, 'management_brief', accumulated, lastDeltaRef);
      },
      signal,
    );
    const parsed = parseModelJson(raw);
    brief = parseBriefFromModel(parsed);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn('[AnalyticsAI] Management brief stream failed:', err?.message || err);
    brief = fallbackManagementBrief(ctx, locale);
    send('delta', {
      mode: 'management_brief',
      executive_summary: brief.executive_summary,
      sales_analysis: brief.sales_analysis,
      expense_analysis: brief.expense_analysis,
    });
  }

  if (!brief.executive_summary || !briefMatchesLocale(brief, locale)) {
    brief = fallbackManagementBrief(ctx, locale);
    send('delta', {
      mode: 'management_brief',
      executive_summary: brief.executive_summary,
      sales_analysis: brief.sales_analysis,
      expense_analysis: brief.expense_analysis,
    });
  }

  const summary = [brief.executive_summary, brief.sales_analysis, brief.expense_analysis]
    .filter(Boolean)
    .join('\n\n');

  send('done', {
    data: {
      mode: 'management_brief',
      executive_summary: brief.executive_summary,
      sales_analysis: brief.sales_analysis,
      expense_analysis: brief.expense_analysis,
      recommendations: brief.recommendations,
      suggestedReplies: brief.suggestedReplies,
      summary,
      bullets: brief.recommendations,
      charts,
      contextMeta: {
        mode: 'management_brief',
        period: { start: start_date, end: end_date },
        locale,
        kpi: ctx.kpi,
        comparisons: ctx.comparisons,
      },
    },
  });
}

module.exports = {
  runAnalyticsChat,
  runManagementBrief,
  runAnalyticsChatStream,
  runManagementBriefStream,
};
