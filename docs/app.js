'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let ST = null;
let PRODUCTS = [];

const STATIC_DEMO = !!window.STATIC_DEMO;
const DEMO_SESSION = { seq: 9000, assets: {}, taken: new Set() };
const DEMO_TAG_POOL = [
  ['创意方向', '折扣促销', 'Discount'], ['创意方向', '多品展示', 'MultiProduct'], ['创意方向', '单品卖点', 'SingleFocus'], ['创意方向', '场景种草', 'Lifestyle'],
  ['人物', '女性', 'Female'], ['人物', '男性', 'Male'], ['主色调', '黑色', 'Black'], ['主色调', '卡其', 'Khaki'], ['主色调', '白色', 'White'],
  ['景别', '特写', 'CloseUp'], ['景别', '全身', 'FullBody'], ['开头钩子', '痛点提问', 'PainQuestion'], ['开头钩子', '效果对比', 'BeforeAfter'], ['口播', '有口播', 'Voiceover'],
];
const MEDIA_CODE_JS = { image: ['IMG', '图片'], video: ['VID', '视频'], gif: ['GIF', 'GIF'] };

function staticFile(path) {
  const u = new URL(path, 'http://x');
  const ps = [...u.searchParams].filter(([, v]) => v !== '').sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const key = u.pathname + (ps.length ? '?' + ps.map(([k, v]) => `${k}=${v}`).join('&') : '');
  return 'data/' + key.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.json';
}

function demoB36(n, w) {
  const a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '', x = Math.max(0, n | 0);
  do { s = a[x % 36] + s; x = Math.floor(x / 36); } while (x);
  return w ? s.padStart(w, '0').slice(-w) : s;
}
function demoClean(s, sep) { return String(s || '').replace(new RegExp(`[${sep.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s]+`, 'g'), '').trim(); }
function demoPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function demoEnumVal(v, source, conf, reason) {
  const d = { value_id: v.id, cn: v.cn, en: v.en, code: v.code, source };
  if (conf != null) d.confidence = conf;
  if (reason) d.reason = reason;
  return d;
}
function demoMatchProduct(filename) {
  const low = (filename || '').toLowerCase();
  return PRODUCTS.find((p) => low.includes((p.spu || '').toLowerCase()) || low.includes((p.handle || '').toLowerCase())) || null;
}
function demoBuildNames(seq, values, tags) {
  const s = ST.settings, sep = s.separator || '_', enFirst = s.name_lang !== 'cn';
  const parts = [];
  for (const f of ST.fields) {
    if (f.type === 'ai_tags') {
      if (s.ai_tags_in_name !== '1') continue;
      const enabled = (tags || []).filter((t) => t.enabled !== false).slice(0, +(s.ai_tags_max || 3));
      const seg = enabled.map((t) => demoClean((enFirst ? t.en || t.cn : t.cn || t.en), sep)).filter(Boolean).join(s.ai_tag_joiner || '+');
      if (seg) parts.push(seg);
      continue;
    }
    const v = values[f.key];
    if (!v) continue;
    let seg = '';
    if (f.type === 'product') seg = v.spu || '';
    else if (f.type === 'enum') seg = enFirst ? (v.en || v.cn) : (v.cn || v.en);
    else if (f.type === 'date') seg = v.date || '';
    else if (f.type === 'version') seg = v.n ? `V${v.n}` : '';
    else if (f.type === 'text') seg = v.text || '';
    seg = demoClean(seg, sep);
    if (seg) parts.push(seg);
  }
  const full = parts.join(sep);
  const w = +(s.code_width || 2);
  let base = '';
  for (const f of ST.fields) {
    if (!f.in_short || !['enum', 'date', 'version', 'text'].includes(f.type)) continue;
    const v = values[f.key] || {};
    if (f.type === 'version') base += 'V' + (v.n > 0 && v.n < 36 ? demoB36(v.n) : '0');
    else if (f.type === 'date') base += String(v.date || '').replace(/\D/g, '').slice(0, 6).padEnd(6, 'X');
    else if (f.type === 'text') base += String(v.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, w).padEnd(w, 'X');
    else base += String(v.code || '').toUpperCase().slice(0, w).padEnd(w, 'X') || 'X'.repeat(w);
  }
  if (!base) base = 'N' + demoB36(seq || 0, 4);
  let short = base;
  if (DEMO_SESSION.taken.has(base)) {
    for (const ch of 'ABCDEFGHJKLMNPQRSTUVWXYZ') {
      if (!DEMO_SESSION.taken.has(base + ch)) { short = base + ch; break; }
    }
  }
  return { full_name: full, short_name: short, duplicates: [] };
}
function demoDefaultValues(mtype, filename) {
  const s = ST.settings, values = {};
  const product = demoMatchProduct(filename) || (PRODUCTS.length ? demoPick(PRODUCTS) : null);
  for (const f of ST.fields) {
    if (f.type === 'product' && product) {
      values[f.key] = { product_id: product.id, spu: product.spu, title: product.title, source: demoMatchProduct(filename) ? 'match' : 'ai',
        confidence: demoMatchProduct(filename) ? 0.95 : 0.72, reason: demoMatchProduct(filename) ? '文件名包含 SPU' : '演示：按画面商品猜测' };
    } else if (f.type === 'enum' && f.key === 'material_type') {
      const [en, cn] = MEDIA_CODE_JS[mtype] || MEDIA_CODE_JS.image;
      const v = f.values.find((x) => x.en === en || x.cn === cn || x.code === en);
      if (v) values[f.key] = demoEnumVal(v, 'file', 1, '由文件类型确定');
    } else if (f.type === 'enum' && f.key === 'designer') {
      const v = f.values.find((x) => String(x.id) === String(s.default_designer)) || f.values[0];
      if (v) values[f.key] = demoEnumVal(v, 'default');
    } else if (f.type === 'date') {
      const d = new Date();
      values[f.key] = { date: String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'), source: 'default' };
    } else if (f.type === 'version') {
      values[f.key] = { n: 1, source: 'default' };
    } else if (f.type === 'enum' && f.values.length && ['expression', 'selling_point', 'scene'].includes(f.key)) {
      const low = (filename || '').toLowerCase();
      const hit = f.values.find((x) => (x.en && low.includes(String(x.en).toLowerCase())) || (x.cn && filename.includes(x.cn)));
      const v = hit || demoPick(f.values);
      values[f.key] = demoEnumVal(v, hit ? 'filename' : 'ai', hit ? 0.85 : 0.7 + Math.random() * 0.25,
        hit ? '文件名包含该词' : '演示识别：根据画面内容匹配');
    }
  }
  return values;
}
function demoAiTags() {
  const cats = [...new Set(DEMO_TAG_POOL.map((t) => t[0]))];
  const picked = [];
  const used = new Set();
  while (picked.length < 4 && used.size < cats.length) {
    const cat = demoPick(cats.filter((c) => !used.has(c)));
    used.add(cat);
    const pool = DEMO_TAG_POOL.filter((t) => t[0] === cat);
    const t = demoPick(pool);
    picked.push({ category: t[0], cn: t[1], en: t[2], enabled: true });
  }
  return picked;
}
function demoBench(an, values) {
  if (!an || !an.summary || !an.summary.roas) return null;
  const avg = an.summary.roas;
  const assets = (an.assets || []).filter((a) => a.spend > 0);
  const sp = assets.map((a) => a.spend).sort((a, b) => a - b);
  const pct = (p) => sp[Math.min(sp.length - 1, Math.floor(sp.length * p))] || 0;
  const matches = [];
  for (const d of an.dims || []) {
    const v = values[d.key];
    if (!v || ['date', 'version', 'designer'].includes(d.key)) continue;
    const want = [v.spu, v.cn, v.en].filter(Boolean);
    const hit = (d.values || []).find((x) => want.some((w) => String(x.label).includes(w)));
    if (hit && hit.spend && hit.roas != null) {
      matches.push({ dim: d.name, label: hit.label, assets: hit.assets, spend: hit.spend, roas: hit.roas, lift: hit.roas / avg - 1, spa: hit.spend / Math.max(1, hit.assets) });
    }
  }
  const w = matches.map((m) => [Math.min(1, m.assets / 5), Math.log(Math.max(m.roas, 0.01) / avg)]);
  const tw = w.reduce((s, x) => s + x[0], 0);
  const est = tw ? avg * Math.exp(0.6 * w.reduce((s, x) => s + x[0] * x[1], 0) / tw) : avg;
  const spa = matches.filter((m) => m.assets >= 2).map((m) => m.spa);
  const estSp = spa.length ? spa.reduce((a, b) => a + b, 0) / spa.length : pct(0.5);
  const tier = estSp >= pct(0.9) ? 'S' : estSp >= pct(0.7) ? 'A' : estSp >= pct(0.4) ? 'B' : 'C';
  const refs = assets.filter((a) => a.spend >= pct(0.5) && a.roas != null).sort((a, b) => b.roas - a.roas).slice(0, 3);
  return {
    sample_assets: assets.length, avg_roas: +avg.toFixed(2), spend_p50: pct(0.5), spend_p90: pct(0.9),
    matches: matches.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift)).slice(0, 8), est_roas: +est.toFixed(2), est_tier: tier,
    refs: refs.map((a) => ({ short_name: a.short_name, roas: a.roas, spend: a.spend })),
  };
}

function demoUnderstanding(media_type, filename, values, meta, bench) {
  const spu = Object.values(values || {}).find((v) => v && v.spu)?.spu || '商品';
  const isVid = media_type === 'video';
  let clips = ((meta && meta.clips) || []).map((c, i) => ({ id: `C${String(i + 1).padStart(2, '0')}`, start: c.start, end: c.end, cont: !!c.cont, thumb: c.thumb }));
  if (!clips.length) clips = [{ id: 'C01', start: 0, end: 0, cont: false }];
  const n = clips.length;
  const roleSeq = (i) => (n === 1 ? 'Hook' : i === 0 ? 'Hook' : i === n - 1 ? 'CTA' : ['Problem', 'Demo', 'Proof', 'Benefit', 'Demo', 'Proof'][(i - 1) % 6]);
  const SHOT = ['特写', '中景', '近景', '全景', '大特写', '中全景'], MOVE = ['推', '固定', '手持跟拍', '摇', '固定', '拉'];
  const ROLE_FACT = {
    Hook: ['P1 正对镜头，手持 G1 快速抬至画面中心', '大字幕弹出：「还在为这个烦恼？」'],
    Problem: ['P1 在 S1 中皱眉拉扯衣领，随后叹气', '字幕「一到下午就闷热黏身」'],
    Demo: ['手部特写拉伸 G1 面料并松开，面料回弹', '字幕「细节看得见」'],
    Proof: ['G1 使用前后对比分屏，左右各 0.8s', '字幕「左：普通款 右：本款」'],
    Benefit: ['P1 穿着 G1 在 S2 自然走动，转身后看向镜头', '字幕「一整天都舒服」'],
    CTA: ['G1 居中静置，背景虚化', '底部按钮样式字幕「点击查看同款」'],
  };
  const fclips = clips.map((c, i) => {
    const r = roleSeq(i);
    const [act, sub] = ROLE_FACT[r] || ROLE_FACT.Demo;
    return {
      ...c, dur: +(c.end - c.start).toFixed(2), shot_size: SHOT[i % SHOT.length], angle: i % 3 === 2 ? '俯拍' : '平视',
      movement: isVid ? (c.cont ? '固定（同镜头延续）' : MOVE[i % MOVE.length]) : '静帧', lens: i % 2 ? '标准 35mm' : '长焦 85mm',
      lighting: i % 2 ? '左前 45° 柔光主光 + 右侧轮廓光，色温约 5200K' : '窗边自然光为主光，白色反光板补暗部，色温约 5600K',
      composition: i % 2 ? '主体位于右三分线，浅景深虚化背景' : '主体居中，上方留白放字幕',
      subject: i % 3 === 2 ? 'G1 细节' : 'P1 与 G1', action: act, products: ['G1'], product_detail: i % 2 ? '面料纹理与缝线' : '整体版型与颜色',
      people: i % 3 === 2 ? [] : ['P1'], scene: i < n / 2 ? 'S1' : 'S2', dialogue: isVid ? (i === 0 ? '（演示）你是不是也遇到过…' : i === n - 1 ? '（演示）链接放在下面了' : '') : '',
      subtitle: sub.replace(/^.*「|」.*$/g, ''), effects: i === 0 ? '字幕弹跳入场 + 轻微缩放' : '', transition_in: i === 0 ? '开场' : c.cont ? '同镜头延续' : '硬切',
      color: '暖调，中高饱和，肤色偏暖',
    };
  });
  const dur = meta && meta.duration;
  const fact = {
    overview: `演示数据：${isVid ? `一条约 ${fmtS(dur)} 的竖版视频，系统按画面突变切出 ${n} 个分镜。` : '一张静态图片。'}女性模特 P1 在室内 S1 与户外 S2 展示商品 G1（${spu}），以特写呈现细节，结尾商品居中并出现行动字幕。`,
    format: { aspect: '9:16', duration_s: dur, style: isVid ? '实拍产品展示 + 口播' : '图文', sound: isVid ? '口播 + 轻快背景音乐' : '无', clip_count: n,
      avg_clip_s: isVid ? +(dur / n).toFixed(2) : undefined },
    products: [{ id: 'G1', name: spu, look: '主色与款式以画面为准（演示）', shown: '上身展示 + 细节特写', clips: fclips.map((c) => c.id), first_seen_s: 0 }],
    people: { count: 1, list: [{ id: 'P1', gender: '女', age: '25–30', look: '偏瘦，黑色长发，淡妆', wardrobe: `${spu} + 浅色下装`, role: '模特/口播者', clips: fclips.filter((c) => c.people.length).map((c) => c.id) }] },
    scenes: [{ id: 'S1', name: '卧室/衣帽间', type: '内景', time: '白天', props: ['落地镜', '衣架'], clips: fclips.filter((c) => c.scene === 'S1').map((c) => c.id) },
      { id: 'S2', name: '街边', type: '外景', time: '白天', props: ['咖啡杯'], clips: fclips.filter((c) => c.scene === 'S2').map((c) => c.id) }],
    audio: isVid ? { voiceover: 'P1 本人口播，英语，语速中等，语气亲切', music: '轻快流行，约 110 BPM', sfx: '字幕入场“叮”声' } : {},
    script: fclips.filter((c) => c.dialogue).map((c) => ({ clip: c.id, t: tRange(c), type: '口播', text: c.dialogue })),
    text_fx: fclips.map((c) => ({ clip: c.id, text: c.subtitle, style: c.id === 'C01' ? '居中白字黑描边，弹跳入场' : '下三分之一白字' })),
    keywords: [spu, '细节', '对比', '同款'],
    tags: [{ category: '形式', value: isVid ? '实拍展示' : '图文' }, { category: '人物', value: '单人女性' }, { category: '景别', value: '特写为主' }, { category: '灯光', value: '柔光' }],
    departments: {
      director: ['开场 0–2s 抛出问题，结尾停留商品 1.5s 给行动指令', `共 ${n} 个分镜，前紧后缓`],
      dop: ['竖版 9:16，85mm 拍细节、35mm 拍人物', '细节镜头使用推镜'],
      gaffer: ['窗光做主光 + 反光板', '外景顺光拍摄，避免硬阴影'],
      art: ['落地镜、衣架、咖啡杯', '背景色与商品主色呼应'],
      wardrobe_makeup: [`P1 穿 ${spu}`, '淡妆、黑色长发自然披肩'],
      cast: ['P1 口播看镜头，展示时视线落在商品上'],
      editor_vfx: ['硬切为主', '字幕弹跳动效', '结尾按钮样式 CTA'],
      sound: ['口播收音 + 轻快 BGM', '字幕入场音效'],
    },
    clips: fclips,
  };
  const cognition = {
    positioning: { category: '服饰', product_role: '主角', one_liner: `演示：用「问题钩子 + 细节证明」向注重质感的年轻女性卖 ${spu}` },
    core_attraction: { type: '痛点共鸣', description: '开场字幕直接点名使用前的困扰，制造自我相关', clips: ['C01'] },
    selling_points: {
      primary: { point: '面料质感', fab: '特征：面料细密 → 优势：贴身不闷 → 利益：一整天穿着舒适', expression: '特写', clips: fclips.filter((c, i) => roleSeq(i) === 'Demo').map((c) => c.id) },
      secondary: [{ point: '版型显瘦', fab: '特征：收腰剪裁 → 优势：修饰身形 → 利益：上镜好看', expression: '上身展示', clips: fclips.filter((c, i) => roleSeq(i) === 'Benefit').map((c) => c.id) }],
    },
    buying_points: {
      jtbd: '想在通勤与周末都穿得体面又舒服', motives: [{ type: '尊重需要', desc: '被看见、被认可的外在形象' }, { type: '安全/舒适', desc: '长时间穿着不难受' }],
      emotions: [{ emotion: '期待', intensity: 3, clips: ['C01'] }, { emotion: '信任', intensity: 3, clips: fclips.filter((c, i) => roleSeq(i) === 'Proof').map((c) => c.id) }, { emotion: '愉悦', intensity: 2, clips: [fclips[n - 1].id] }],
      emotional_arc: '困扰 → 好奇 → 确认 → 轻松', atmosphere: '明亮、日常、轻生活方式',
    },
    audience: { persona: '25–34 岁都市女性，注重性价比与质感', awareness: '问题意识', sophistication: '同类商品多，需要靠细节证明差异', scenario: '通勤、周末出街' },
    persuasion: { structure: 'PAS（问题-放大-方案）', route: '混合：细节特写走中心路径，模特形象走边缘路径',
      principles: [{ name: '社会认同', evidence: '真人上身展示', clips: fclips.filter((c) => c.people.length).slice(0, 2).map((c) => c.id) }], proof_types: ['演示', '对比', '质感'] },
    abcd: { attention: 'C01 问题字幕 + 商品抬入画面', branding: `G1 在 C01 即出现，全片 ${n} 个分镜均可见`, connection: '真人日常场景', direction: `结尾 ${fclips[n - 1].id} 出现「点击查看同款」` },
    fogg: { motivation: '想要好看又舒服', ability: '「同款」降低搜索成本', prompt: '结尾按钮样式字幕' },
    meta_fit: { first_3s: '0–2s 出现问题字幕与商品', sound_off: '主要信息有字幕承载', vertical: '9:16 全屏', native_feel: '口播 + 生活场景，偏原生' },
    clip_roles: fclips.map((c, i) => {
      const r = roleSeq(i);
      return { clip: c.id, role: r, function: { Hook: '停滑并抛出议题', Problem: '让目标用户代入问题', Demo: '展示商品如何解决问题', Proof: '提供可信证据', Benefit: '把功能翻译成生活利益', CTA: '给出明确下一步' }[r],
        mechanism: { Hook: '自我相关 + 未完成感', Problem: '损失厌恶', Demo: '具体性效应', Proof: '眼见为实 / 对比效应', Benefit: '心理模拟（想象自己穿上）', CTA: '降低行动门槛' }[r],
        reuse: { Hook: '开头钩子', CTA: '结尾转化', Proof: '中段证明', Demo: '中段证明', Problem: '开头第二镜', Benefit: '中段/结尾前' }[r] };
    }),
    tags: [{ category: '钩子类型', value: '痛点提问' }, { category: '说服结构', value: 'PAS' }, { category: '认知阶段', value: '问题意识' }, { category: '情绪', value: '期待→信任' }],
  };
  const est = bench ? bench.est_roas : 2.1;
  const last = fclips[n - 1], first = fclips[0];
  const judgment = {
    prediction: { spend_tier: bench ? bench.est_tier : 'B', roas_low: +(est * 0.88).toFixed(2), roas_high: +(est * 1.12).toFixed(2),
      vs_baseline: bench ? (est > bench.avg_roas * 1.05 ? '高于' : est < bench.avg_roas * 0.95 ? '低于' : '持平') : '持平', confidence: bench ? 0.55 : 0.35,
      summary: `演示判断：以同标签历史 ROAS 为锚点；开场问题钩子与细节特写是加分项，CTA 停留偏短与证明镜头偏少是主要拖累。` },
    funnel: [['L1', 4, 'pass', '首帧即出现问题字幕与商品', [first.id]], ['L2', 3, 'weak', '人群线索只有模特年龄感，缺少场景点名', [first.id]],
      ['L3', 3, 'weak', 'PAS 结构完整但放大段较短', fclips.slice(1, 3).map((c) => c.id)], ['L4', 3, 'weak', '只有 1 处对比证明', fclips.filter((c, i) => roleSeq(i) === 'Proof').map((c) => c.id)],
      ['L5', 4, 'pass', '景别有特写/中景交替，光线干净', []], ['L6', 3, 'weak', `CTA 仅出现在 ${last.id}`, [last.id]], ['L7', 4, 'pass', '钩子与证明镜头可单独替换', []]]
      .map(([id, score, verdict, reason, clips]) => ({ id, score, verdict, reason, clips })),
    positives: [{ factor: '首镜即出商品 + 问题字幕', clips: [first.id], evidence: `${first.id}：${first.action}`, benchmark: bench && bench.matches[0] ? `${bench.matches[0].dim}=${bench.matches[0].label} 历史 ROAS ${(+bench.matches[0].roas).toFixed(2)}` : '创意规律', impact: '高' }],
    negatives: [{ factor: 'CTA 停留过短', clips: [last.id], evidence: `${last.id} 时长 ${fmtS(last.dur)}`, benchmark: '创意规律：CTA 停留 ≥1.5s 点击率更稳', impact: '中' },
      { factor: '证明镜头不足', clips: fclips.filter((c, i) => roleSeq(i) === 'Proof').map((c) => c.id), evidence: '全片仅 1 处前后对比', benchmark: '创意规律', impact: '中' }],
    edits: [
      { priority: 1, clip: first.id, target: tRange(first), type: '字幕', current: first.subtitle, change: '改为「通勤一整天也不闷？」并在 0.3s 内弹出', reason: '把痛点具体到使用场景，提高自我相关', expected: '钩子率 ↑',
        prompt: `字幕替换：${first.id}（${tRange(first)}）主字幕改为「通勤一整天也不闷？」，居中白字黑描边，0.3s 弹跳入场，保持原画面不变。` },
      { priority: 2, clip: last.id, target: tRange(last), type: '分镜替换', current: last.action, change: `延长至 2s：P1 手持 ${spu} 面向镜头微笑，下方按钮字幕「点击查看同款 →」`, reason: 'CTA 停留太短，用户来不及行动', expected: 'CTR ↑',
        prompt: `9:16 竖版，2 秒。25–30 岁亚洲女性 P1，偏瘦、黑色长发自然披肩、淡妆，身穿 ${spu}（颜色款式与原片一致）。站在明亮的卧室落地镜前，双手将商品轻轻举到胸前并朝镜头微笑，动作从静止开始、1 秒内完成、最后停住。中景平视，镜头缓慢推近 5%，35mm 标准焦段，浅景深。窗边自然光作主光，白色反光板补光，色温约 5600K，暖调中高饱和。真实生活方式质感。底部留出字幕安全区。不出现任何文字水印，手指与肢体不变形，商品外观与 logo 不改变。`,
        prompt_en: `9:16 vertical, 2 seconds. Asian woman (P1), 25–30, slim, long straight black hair, natural makeup, wearing ${spu} (same color and style as the original). In a bright bedroom in front of a floor mirror, she gently raises the product to chest level and smiles at camera; motion starts from still, completes within 1s, then holds. Medium shot, eye level, slow 5% push-in, 35mm, shallow depth of field. Window daylight key light with white bounce fill, ~5600K, warm, mid-high saturation. Authentic lifestyle look. Keep the lower third clear for captions. No text or watermark, no deformed hands or limbs, product appearance and logo unchanged.` },
    ],
    keep: [`${first.id} 商品入画方式`, '人物与场景', '整体色调与音乐'],
    benchmark: bench,
  };
  return { version: 'fcj-1', media_type, duration: dur, clips_source: meta && meta.clips && meta.clips.length > 1 ? 'auto_cut' : 'uniform',
    one_liner: cognition.positioning.one_liner, fact, cognition, judgment };
}

function demoCreateAsset({ filename, media_type, size, thumb, blobUrl }) {
  const seq = ++DEMO_SESSION.seq;
  const id = seq;
  const values = demoDefaultValues(media_type, filename);
  const ai_tags = demoAiTags();
  const names = demoBuildNames(seq, values, ai_tags);
  const understanding = demoUnderstanding(media_type, filename, values);
  DEMO_SESSION.taken.add(names.short_name);
  const a = {
    id, seq, filename, ext: (filename.split('.').pop() || '').toLowerCase(), media_type, size: size || 0,
    file_path: blobUrl || '', thumb: thumb || null, product_id: (Object.values(values).find((v) => v && v.product_id) || {}).product_id || null,
    description: understanding.one_liner,
    full_name: names.full_name, short_name: names.short_name, media_ids: [], status: 'pending',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), learned_ids: [], short_history: '',
    values, ai_tags, understanding, ai_raw: { pipeline: 'fcj-demo', understanding }, mode: 'demo', demo: true,
  };
  DEMO_SESSION.assets[id] = a;
  return clone(a);
}

async function api(method, path, body, opts = {}) {
  if (STATIC_DEMO) {
    if (path === '/api/names/preview') {
      const seq = (body && body.seq) || (body && body.id && DEMO_SESSION.assets[body.id] && DEMO_SESSION.assets[body.id].seq) || 1;
      return demoBuildNames(seq, (body && body.values) || {}, (body && body.ai_tags) || []);
    }
    if (method === 'POST' && path.startsWith('/api/assets/upload')) {
      const u = new URL(path, 'http://x');
      const filename = u.searchParams.get('filename') || 'demo.jpg';
      const media_type = u.searchParams.get('media_type') || 'image';
      const blob = body instanceof Blob ? body : new Blob([body || '']);
      const blobUrl = URL.createObjectURL(blob);
      return demoCreateAsset({ filename, media_type, size: blob.size, blobUrl });
    }
    const am = path.match(/^\/api\/assets\/(\d+)\/analyze$/);
    if (method === 'POST' && am) {
      const a = DEMO_SESSION.assets[+am[1]];
      if (!a) throw new Error('演示素材不存在');
      if (body && body.thumb) a.thumb = body.thumb;
      if (!a.ai_tags.length) a.ai_tags = demoAiTags();
      if (DEMO_SESSION.an === undefined) {
        DEMO_SESSION.an = await fetch(staticFile('/api/analytics')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      }
      a.understanding = demoUnderstanding(a.media_type, a.filename, a.values, { clips: body && body.clips, duration: body && body.duration },
        demoBench(DEMO_SESSION.an, a.values));
      Object.assign(a, demoBuildNames(a.seq, a.values, a.ai_tags));
      a.mode = 'demo';
      a.status = 'pending';
      a.description = a.understanding.one_liner || a.description;
      a.ai_raw = { pipeline: 'fcj-demo', understanding: a.understanding };
      DEMO_SESSION.assets[a.id] = a;
      return clone(a);
    }
    const sm = path.match(/^\/api\/assets\/(\d+)$/);
    if (method === 'PUT' && sm) {
      const a = DEMO_SESSION.assets[+sm[1]];
      if (!a) throw new Error('演示素材不存在，请先在本页上传');
      a.values = body.values || a.values;
      a.ai_tags = body.ai_tags || a.ai_tags;
      if (body.media_ids != null) a.media_ids = String(body.media_ids).split(/[,，\s]+/).filter(Boolean);
      const names = demoBuildNames(a.seq, a.values, a.ai_tags);
      DEMO_SESSION.taken.delete(a.short_name);
      DEMO_SESSION.taken.add(names.short_name);
      a.full_name = names.full_name;
      a.short_name = names.short_name;
      a.status = 'named';
      a.updated_at = new Date().toISOString();
      return clone(a);
    }
    if (method === 'GET' && path === '/api/assets') {
      const r = await fetch(staticFile(path));
      const list = r.ok ? await r.json() : [];
      return [...Object.values(DEMO_SESSION.assets), ...list];
    }
    if (method === 'GET' && sm) {
      if (DEMO_SESSION.assets[+sm[1]]) return clone(DEMO_SESSION.assets[+sm[1]]);
    }
    if (method !== 'GET') throw new Error('这是在线演示版，不能修改知识库/投放数据；上传命名可在本页试用');
    const r = await fetch(staticFile(path));
    if (!r.ok) throw new Error('演示版只包含默认时间窗口（近 30 日）的数据，请清空日期筛选');
    return r.json();
  }
  const init = { method, headers: {} };
  if (body !== undefined) {
    if (opts.raw) { init.body = body; } else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(path, init);
  const txt = await r.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { error: txt }; }
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 2800);
}
const fail = (e) => toast(e.message || String(e), 'err');

async function loadState(st) {
  ST = st || await api('GET', '/api/state');
  if (ST.readonly && !document.body.classList.contains('ro')) {
    document.body.classList.add('ro');
    document.body.insertAdjacentHTML('afterbegin', `<div class="ro-bar">${STATIC_DEMO
      ? '在线演示 · 可试用「上传 & AI 命名」与三个分析视角；命名结果仅保存在本页会话，不会写入服务器'
      : '只读分享视图 · 可浏览全部分析与下钻，不能修改数据'}</div>`);
  }
  $('#navFoot').innerHTML = `商品 ${ST.counts.products} · 素材 ${ST.counts.assets}<br>投放数据 ${ST.counts.perf} 行<br>${ST.settings.ai_api_key_set ? '<span style="color:#7ee2b0">● AI 已连接</span>' : '<span style="color:#f5b971">● AI 未配置</span>'}`;
}
async function loadProducts() { PRODUCTS = await api('GET', '/api/products'); }

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('已复制：' + text, 'ok'), () => toast('复制失败', 'err'));
}

function openModal(title, node) {
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.innerHTML = '';
  body.appendChild(node);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
$('#modalClose').onclick = closeModal;

const TYPE_LABEL = { enum: '字典', text: '自由文本', product: '商品SPU', date: '日期', version: '版本号', ai_tags: 'AI标签' };
const MATCH_LABEL = { media_id: '媒体素材ID', short_name: '短名称', full_name: '完整命名', learned_id: '素材ID(自动学习)', code_decode: '短码解码', unmatched: '未匹配' };
const MATCH_COLOR = { media_id: '#4f5bd5', short_name: '#12a36b', full_name: '#00a8c6', learned_id: '#8e9af0', code_decode: '#d98a00', unmatched: '#c9ccd8' };

/* ------------------------------------------------------------------ 媒体抽帧 */

function loadMedia(src, isVideo) {
  return new Promise((res, rej) => {
    if (isVideo) {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true; v.crossOrigin = 'anonymous';
      v.onloadeddata = () => res(v);
      v.onerror = () => rej(new Error('浏览器无法解码该视频（建议 H.264 MP4），将仅按文件名识别'));
      v.src = src;
    } else {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片无法读取'));
      im.src = src;
    }
  });
}

function drawFrame(el, max, q = 0.75) {
  const w0 = el.videoWidth || el.naturalWidth, h0 = el.videoHeight || el.naturalHeight;
  const k = Math.min(1, max / Math.max(w0, h0));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w0 * k); cv.height = Math.round(h0 * k);
  cv.getContext('2d').drawImage(el, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', q);
}

const seekTo = (el, t) => new Promise((res) => { el.onseeked = res; el.currentTime = t; });

function frameSig(el, cv) {
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(el, 0, 0, cv.width, cv.height);
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const px = new Float32Array(d.length / 4 * 3), hist = new Float32Array(48);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    px[j] = d[i]; px[j + 1] = d[i + 1]; px[j + 2] = d[i + 2];
    hist[d[i] >> 4]++; hist[16 + (d[i + 1] >> 4)]++; hist[32 + (d[i + 2] >> 4)]++;
  }
  return { px, hist, n: d.length / 4 };
}

function sigDiff(a, b) {
  let p = 0, h = 0;
  for (let i = 0; i < a.px.length; i++) p += Math.abs(a.px[i] - b.px[i]);
  for (let i = 0; i < 48; i++) h += Math.abs(a.hist[i] - b.hist[i]);
  return 0.5 * p / (a.px.length * 255) + 0.5 * h / (a.n * 6);
}

// 画面突变切镜：像素差 + 颜色直方图差，阈值随片子自身的运动幅度自适应
async function detectCuts(el, duration) {
  const step = Math.max(0.2, Math.min(duration, 180) / 160);
  const cv = document.createElement('canvas');
  cv.width = 48; cv.height = 27;
  const ds = [];
  let prev = null;
  for (let t = 0; t < duration - 0.05; t += step) {
    await seekTo(el, t);
    const s = frameSig(el, cv);
    if (prev) ds.push({ t, d: sigDiff(prev, s) });
    prev = s;
  }
  const sorted = ds.map((x) => x.d).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const thr = Math.max(0.12, med * 4);
  const cuts = [];
  for (let i = 0; i < ds.length; i++) {
    const x = ds[i];
    const local = x.d >= (ds[i - 1]?.d || 0) && x.d >= (ds[i + 1]?.d || 0);
    if (x.d > thr && local && x.t - (cuts[cuts.length - 1] ?? 0) >= 0.45) cuts.push(+x.t.toFixed(2));
  }
  return cuts;
}

function buildClips(cuts, duration) {
  const bounds = [0, ...cuts, duration];
  let clips = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const st = bounds[i], en = bounds[i + 1];
    // 超长单镜头（如整段口播）按 ≤5s 拆成同镜头续段，便于逐段理解与混剪
    const parts = Math.max(1, Math.ceil((en - st) / 5));
    for (let k = 0; k < parts; k++) {
      clips.push({ start: +(st + (en - st) * k / parts).toFixed(2), end: +(st + (en - st) * (k + 1) / parts).toFixed(2), cont: k > 0 });
    }
  }
  while (clips.length > 40) {
    let mi = 0;
    clips.forEach((c, i) => { if (i < clips.length - 1 && c.end - c.start + clips[i + 1].end - clips[i + 1].start < clips[mi].end - clips[mi].start + clips[mi + 1].end - clips[mi + 1].start) mi = i; });
    clips.splice(mi, 2, { start: clips[mi].start, end: clips[mi + 1].end, cont: clips[mi].cont });
  }
  return clips;
}

async function extractFrames(src, mediaType, onStep) {
  const isVideo = mediaType === 'video';
  const el = await loadMedia(src, isVideo);
  const frames = [];
  let thumb, duration = null, clips;
  if (isVideo) {
    if (!Number.isFinite(el.duration)) {
      await new Promise((res) => {
        const fin = () => { el.ondurationchange = el.onseeked = null; res(); };
        el.ondurationchange = el.onseeked = fin;
        setTimeout(fin, 4000);
        el.currentTime = 1e7;
      });
    }
    duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : el.currentTime || 1;
    if (onStep) onStep('智能切镜');
    clips = buildClips(await detectCuts(el, duration), duration);
    const big = clips.length > 16 ? 448 : 640;
    for (const c of clips) {
      await seekTo(el, Math.min(duration - 0.05, (c.start + c.end) / 2));
      frames.push(drawFrame(el, big, 0.7));
      c.thumb = drawFrame(el, 200, 0.65);
    }
    await seekTo(el, Math.min(0.1, duration / 2));
    thumb = drawFrame(el, 320, 0.7);
  } else {
    frames.push(drawFrame(el, 1024, 0.8));
    thumb = drawFrame(el, 320, 0.7);
    clips = [{ start: 0, end: 0, cont: false, thumb: drawFrame(el, 200, 0.65) }];
  }
  return { frames, thumb, duration, clips };
}

const analyzeBody = (ex) => ({
  frames: ex.frames || [], thumb: ex.thumb, duration: ex.duration,
  clips: (ex.clips || []).map(({ start, end, cont, thumb }) => ({ start, end, cont, thumb })),
});

/* ------------------------------------------------------------------ 命名编辑器 */

function productOptions(selectedId) {
  return `<option value="">（未关联商品）</option>` + PRODUCTS.map((p) =>
    `<option value="${p.id}" ${String(p.id) === String(selectedId) ? 'selected' : ''}>${esc(p.spu)} · ${esc((p.title || '').slice(0, 40))}</option>`).join('');
}

const ROLE_COLOR = {
  Hook: '#e5484d', Context: '#12a3a3', Problem: '#f08c00', Agitate: '#f76707', Demo: '#4f5bd5', Proof: '#2f80ed',
  Benefit: '#12a36b', Offer: '#8e44ad', CTA: '#a21caf', Brand: '#6b7280', Bridge: '#a0a6b8',
};
const ROLE_CN = {
  Hook: '钩子', Context: '情境', Problem: '痛点', Agitate: '放大', Demo: '演示', Proof: '证明',
  Benefit: '利益', Offer: '优惠', CTA: '行动', Brand: '品牌', Bridge: '过渡',
};
const DEPTS = [['director', '导演/编剧'], ['dop', '摄影指导'], ['gaffer', '灯光'], ['art', '美术/道具'],
  ['wardrobe_makeup', '服装/化妆'], ['cast', '演员/调度'], ['editor_vfx', '剪辑/包装'], ['sound', '录音/音乐']];
const FUNNEL_NAMES = { L1: '注意力', L2: '认同', L3: '叙事', L4: '信任', L5: '视听', L6: '台词', L7: '可复刻' };

const fmtS = (x) => (x == null || x === '' || Number.isNaN(+x) ? '' : `${(+x).toFixed(1)}s`);
const tRange = (c) => (c.start == null ? (c.label || '') : c.end > c.start ? `${fmtS(c.start)}–${fmtS(c.end)}` : '静帧');
const txt = (v) => (Array.isArray(v) ? v.map(txt).filter(Boolean).join('、')
  : v == null ? '' : typeof v === 'object' ? Object.values(v).map(txt).filter(Boolean).join(' · ') : String(v));
const kv = (k, v) => (txt(v) ? `<div class="kv"><span>${esc(k)}</span><div>${esc(txt(v))}</div></div>` : '');
const crefs = (ids) => {
  const arr = [].concat(ids || []).filter(Boolean);
  return arr.length ? `<span class="crefs">${arr.map((id) => `<button type="button" class="cref" data-seek="${esc(id)}">${esc(id)}</button>`).join('')}</span>` : '';
};
const tagChips = (arr) => (arr || []).filter((t) => t && (t.value || t.cn || typeof t === 'string')).map((t) => typeof t === 'string'
  ? `<span class="chip">${esc(t)}</span>` : `<span class="chip"><span class="cat">${esc(t.category || '')}</span>${esc(t.value || t.cn)}</span>`).join('');
const roleOf = (u, id) => ((u.cognition && u.cognition.clip_roles) || []).find((x) => x.clip === id);
const roleBadge = (r) => (r && r.role ? `<span class="role" style="background:${ROLE_COLOR[r.role] || '#666'}">${esc(r.role)} ${esc(ROLE_CN[r.role] || '')}</span>` : '');
const box = (title, body, cls = '') => (body ? `<div class="mod ${cls}"><div class="mod-h">${title}</div>${body}</div>` : '');

function timelineHtml(u) {
  const clips = (u.fact && u.fact.clips) || [];
  if (clips.length < 2 || clips[0].start == null) return '';
  const used = new Set();
  const segs = clips.map((c) => {
    const r = roleOf(u, c.id);
    if (r && r.role) used.add(r.role);
    return `<button type="button" class="tl-seg${c.cont ? ' cont' : ''}" data-seek="${c.id}" data-clip="${c.id}"
      style="flex:${Math.max(0.05, c.end - c.start)};background:${(r && ROLE_COLOR[r.role]) || '#c6cae0'}"
      title="${esc(`${c.id} ${tRange(c)} ${r ? r.role + ' · ' + (r.function || '') : ''}`)}"><span>${c.id.slice(1)}</span></button>`;
  }).join('');
  return `<div class="tl">${segs}<div class="tl-head" data-r="playhead"></div></div>
    <div class="tl-legend">${[...used].map((k) => `<span><i style="background:${ROLE_COLOR[k]}"></i>${ROLE_CN[k] || k}</span>`).join('')}</div>`;
}

function clipCard(c, u) {
  const r = roleOf(u, c.id);
  return `<div class="clip" data-clip="${c.id}">
    <div class="clip-img" data-seek="${c.id}">${c.thumb ? `<img src="${c.thumb}">` : '<div class="ph">无关键帧</div>'}
      <span class="clip-t">${c.id} · ${esc(tRange(c))}${c.cont ? ' · 续' : ''}</span>${roleBadge(r)}</div>
    <div class="clip-b">
      <div class="clip-cam">${[c.shot_size, c.angle, c.movement, c.lens].filter(Boolean).map(esc).join(' · ') || '<span class="muted">镜头信息待识别</span>'}</div>
      ${kv('主体', c.subject)}${kv('动作', c.action)}
      ${kv('商品', [txt(c.products), c.product_detail].filter(Boolean).join(' '))}
      ${kv('人物', c.people)}${kv('场景', c.scene)}
      ${kv('灯光', c.lighting)}${kv('构图', c.composition)}${kv('色调', c.color)}
      ${kv('台词', c.dialogue)}${kv('字幕', c.subtitle)}${kv('特效', c.effects)}${kv('转场', c.transition_in)}
    </div></div>`;
}

function factHtml(u) {
  const f = u.fact || {}, fm = f.format || {}, pp = f.people || {}, au = f.audio || {};
  const meta = [['时长', fmtS(fm.duration_s || u.duration)], ['画幅', fm.aspect], ['形式', fm.style], ['声音', fm.sound],
    ['分镜', fm.clip_count ? `${fm.clip_count} 个` : ''], ['平均镜长', fmtS(fm.avg_clip_s)],
    ['切镜', u.clips_source === 'auto_cut' ? '画面突变自动切镜' : u.clips_source === 'uniform' ? '均匀抽帧' : ''],
    ['口播转写', f.asr ? `已转写 ${f.asr.language || ''}` : '']].filter((x) => x[1]);
  const items = (arr, fn) => (arr || []).filter((x) => x && typeof x === 'object').map(fn).join('');
  const mods = [
    box(`出镜商品 <b>${(f.products || []).length}</b>`, items(f.products, (p) => `<div class="it"><b>${esc(p.id || '')}</b> ${esc(p.name || '')}
      <div class="small muted">${esc([p.look, p.shown].filter(Boolean).join(' · '))}</div>${crefs(p.clips)}</div>`)),
    box(`人物 <b>${pp.count ?? (pp.list || []).length}</b>`, items(pp.list, (p) => `<div class="it"><b>${esc(p.id || '')}</b> ${esc([p.gender, p.age, p.role].filter(Boolean).join(' · '))}
      <div class="small muted">${esc([p.look, p.wardrobe].filter(Boolean).join(' · '))}</div>${crefs(p.clips)}</div>`) || '<div class="small muted">无人物出镜</div>'),
    box(`场景 <b>${(f.scenes || []).length}</b>`, items(f.scenes, (s) => `<div class="it"><b>${esc(s.id || '')}</b> ${esc(s.name || '')}
      <div class="small muted">${esc([s.type, s.time, txt(s.props)].filter(Boolean).join(' · '))}</div>${crefs(s.clips)}</div>`)),
    box('声音', kv('口播', au.voiceover) + kv('音乐', au.music) + kv('音效', au.sfx)),
    box('台词脚本', items(f.script, (s) => `<div class="it"><button type="button" class="cref" data-seek="${esc(s.clip || '')}">${esc(s.clip || '')}</button>
      <span class="small muted">${esc(s.t || '')} ${esc(s.type || '')}</span><div>${esc(s.text || '')}</div></div>`), 'wide'),
    box('字幕 / 特效', items(f.text_fx, (s) => `<div class="it"><button type="button" class="cref" data-seek="${esc(s.clip || '')}">${esc(s.clip || '')}</button>
      ${esc(s.text || '')}<div class="small muted">${esc(s.style || '')}</div></div>`)),
    box('关键词 · 打标', `${(f.keywords || []).length ? `<div class="chips">${(f.keywords || []).map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div>` : ''}
      <div class="chips" style="margin-top:6px">${tagChips(f.tags)}</div>`),
  ].filter(Boolean).join('');
  const depts = DEPTS.filter(([k]) => (f.departments || {})[k] && txt(f.departments[k]))
    .map(([k, n]) => `<div class="dept"><b>${n}</b><ul>${[].concat(f.departments[k]).map((x) => `<li>${esc(txt(x))}</li>`).join('')}</ul></div>`).join('');
  const clips = (f.clips || []);
  return `<div class="ov"><div class="ov-h">总述</div><p>${esc(f.overview || '—')}</p>
      <div class="chips">${meta.map(([k, v]) => `<span class="chip"><span class="cat">${k}</span>${esc(v)}</span>`).join('')}</div></div>
    <div class="mods">${mods}</div>
    ${depts ? `<details class="depts"><summary>剧组岗位视角 · 复刻准备清单</summary><div class="dept-grid">${depts}</div></details>` : ''}
    <div class="sec-h">分镜拆解 <span class="small muted">${clips.length} 个分镜 · 点击关键帧跳到对应秒数</span></div>
    <div class="clips">${clips.map((c) => clipCard(c, u)).join('') || '<div class="small muted">暂无分镜</div>'}</div>`;
}

function cogHtml(u) {
  const g = u.cognition || {};
  const empty = !g.positioning || !Object.keys(g.positioning).length && !(g.clip_roles || []).length;
  if (empty) return '<div class="empty">认知层需要 AI：请在设置中配置 AI Key 后重新识别。</div>';
  const po = g.positioning, ca = g.core_attraction, sp = g.selling_points || {}, bp = g.buying_points || {},
    au = g.audience || {}, ps = g.persuasion || {}, ab = g.abcd || {}, fo = g.fogg || {}, mf = g.meta_fit || {};
  const pt = (x) => (x && x.point ? `<div class="it"><b>${esc(x.point)}</b>${crefs(x.clips)}
    <div class="small">${esc(x.fab || '')}</div><div class="small muted">表达方式：${esc(x.expression || '—')}</div></div>` : '');
  const emos = (bp.emotions || []).map((e) => `<span class="chip">${esc(e.emotion || '')}<span class="dots">${'●'.repeat(Math.max(0, Math.min(5, +e.intensity || 0)))}</span>${crefs(e.clips)}</span>`).join('');
  const clips = (u.fact && u.fact.clips) || [];
  const roles = (g.clip_roles || []).map((r) => {
    const c = clips.find((x) => x.id === r.clip) || {};
    return `<div class="clip role-card" data-clip="${esc(r.clip)}">
      <div class="clip-img sm" data-seek="${esc(r.clip)}">${c.thumb ? `<img src="${c.thumb}">` : '<div class="ph"></div>'}
        <span class="clip-t">${esc(r.clip)} · ${esc(tRange(c))}</span>${roleBadge(r)}</div>
      <div class="clip-b">${kv('作用', r.function)}${kv('机制', r.mechanism)}${kv('复用', r.reuse)}</div></div>`;
  }).join('');
  return `<div class="ov"><div class="ov-h">定位</div><p>${esc(po.one_liner || u.one_liner || '')}</p>
      <div class="chips">${po.category ? `<span class="chip"><span class="cat">品类</span>${esc(po.category)}</span>` : ''}${po.product_role ? `<span class="chip"><span class="cat">商品角色</span>${esc(po.product_role)}</span>` : ''}</div></div>
    <div class="mods">
      ${box('核心吸引力', ca && (ca.type || ca.description) ? `<div class="it"><span class="badge pri">${esc(ca.type || '')}</span> ${esc(ca.description || '')}${crefs(ca.clips)}</div>` : '')}
      ${box('受众与认知阶段', kv('画像', au.persona) + kv('认知阶段', au.awareness) + kv('市场成熟度', au.sophistication) + kv('使用场景', au.scenario))}
      ${box('卖点（商品给什么 · FAB）', (sp.primary && sp.primary.point ? '<div class="small muted">主卖点</div>' + pt(sp.primary) : '')
        + ((sp.secondary || []).length ? '<div class="small muted" style="margin-top:6px">次卖点</div>' + sp.secondary.map(pt).join('') : ''), 'wide')}
      ${box('买点（用户为什么买）', kv('要完成的任务', bp.jtbd) + kv('动机', (bp.motives || []).map((m) => `${m.type || ''}：${m.desc || ''}`))
        + (emos ? `<div class="kv"><span>情绪</span><div class="chips">${emos}</div></div>` : '') + kv('情绪走向', bp.emotional_arc) + kv('氛围', bp.atmosphere), 'wide')}
      ${box('说服机制', kv('结构', ps.structure) + kv('加工路径', ps.route) + kv('证据类型', ps.proof_types)
        + (ps.principles || []).map((p) => `<div class="it"><b>${esc(p.name || '')}</b> ${esc(p.evidence || '')}${crefs(p.clips)}</div>`).join(''), 'wide')}
      ${box('ABCD', kv('Attention', ab.attention) + kv('Branding', ab.branding) + kv('Connection', ab.connection) + kv('Direction', ab.direction))}
      ${box('Fogg 行为模型', kv('动机', fo.motivation) + kv('能力', fo.ability) + kv('提示', fo.prompt))}
      ${box('Meta 投放适配', kv('前 3 秒', mf.first_3s) + kv('无声可读', mf.sound_off) + kv('竖版', mf.vertical) + kv('原生感', mf.native_feel))}
    </div>
    <div class="sec-h">分镜功能 <span class="small muted">每个分镜在广告里承担什么、为什么起作用、混剪时放哪里</span></div>
    <div class="clips">${roles || '<div class="small muted">暂无</div>'}</div>
    ${(g.tags || []).length ? `<div class="sec-h">认知标签</div><div class="chips">${tagChips(g.tags)}</div>` : ''}
    <div class="small muted" style="margin-top:12px">方法论：${(g.frameworks || []).map(esc).join('；')}</div>`;
}

function judgeHtml(u) {
  const j = u.judgment || {}, p = j.prediction || {}, b = j.benchmark;
  const vsCls = { 高于: 'ok', 低于: 'bad' }[p.vs_baseline] || '';
  const conf = p.confidence != null ? Math.round(+p.confidence * 100) : null;
  const pred = `<div class="pred">
    <div class="tier tier-${esc(p.spend_tier || 'X')}">${esc(p.spend_tier || '?')}<small>消耗档位</small></div>
    <div class="pred-m"><div class="pred-roas">${p.roas_low != null && p.roas_high != null ? `ROAS ${(+p.roas_low).toFixed(2)} – ${(+p.roas_high).toFixed(2)}` : 'ROAS 待判断'}
      ${p.vs_baseline ? `<span class="badge ${vsCls}">${esc(p.vs_baseline)}账户均值</span>` : ''}</div>
      ${conf != null ? `<div class="conf"><i style="width:${conf}%"></i></div><div class="small muted">置信度 ${conf}%</div>` : ''}
      <p>${esc(p.summary || '')}</p></div></div>
    <div class="small muted tier-key">S 可放量主力 · A 稳定消耗 · B 小量消耗 · C 难起量</div>`;
  const basis = b ? `<details class="basis" open><summary>判断依据 · 历史投放基准（${b.sample_assets} 条有消耗素材，账户 ROAS ${b.avg_roas}）</summary>
      <div class="small">统计先验：ROAS ≈ <b>${b.est_roas}</b> · 档位 <b>${esc(b.est_tier)}</b> · 单素材消耗中位 ${Math.round(b.spend_p50)} / P90 ${Math.round(b.spend_p90)}</div>
      ${(b.matches || []).length ? `<table class="t mini"><thead><tr><th>同标签</th><th class="num">素材</th><th class="num">消耗</th><th class="num">ROAS</th><th class="num">较均值</th></tr></thead><tbody>
        ${b.matches.map((m) => `<tr><td>${esc(m.dim)}：${esc(m.label)}</td><td class="num">${m.assets}</td><td class="num">${Math.round(m.spend)}</td><td class="num">${(+m.roas).toFixed(2)}</td>
        <td class="num" style="color:${m.lift >= 0 ? 'var(--ok)' : 'var(--bad)'}">${m.lift >= 0 ? '+' : ''}${Math.round(m.lift * 100)}%</td></tr>`).join('')}</tbody></table>` : '<div class="small muted">没有与本素材标签相同的历史素材</div>'}
      ${(b.refs || []).length ? `<div class="small">高 ROAS 参照：${b.refs.map((r) => `<code>${esc(r.short_name)}</code> ${(+r.roas).toFixed(2)}`).join('；')}</div>` : ''}</details>`
    : '<div class="small muted">无历史投放数据，判断仅依据创意规律。导入投放数据后重新识别可获得统计先验。</div>';
  const funnel = (j.funnel || []).length ? `<div class="efn">${j.funnel.map((l) => {
    const cls = { pass: 'ok', weak: 'new', fail: 'bad' }[l.verdict] || '';
    return `<div class="efn-c ${cls}" title="${esc(l.reason || '')}"><b>${esc(l.id)}</b><span>${esc(FUNNEL_NAMES[l.id] || l.name || '')}</span>
      <div class="efn-bar"><i style="width:${(+l.score || 0) * 20}%"></i></div><small>${l.score != null ? l.score + '/5' : '—'}</small></div>`;
  }).join('')}</div>
    <div class="efn-reasons">${j.funnel.filter((l) => l.reason).map((l) => `<div class="small"><b>${esc(l.id)}</b> ${esc(l.reason)} ${crefs(l.clips)}</div>`).join('')}</div>` : '';
  const factor = (x) => `<div class="it"><b>${esc(x.factor || '')}</b> <span class="badge">${esc(x.impact || '')}影响</span>${crefs(x.clips)}
    ${x.evidence ? `<div class="small">事实：${esc(x.evidence)}</div>` : ''}${x.benchmark ? `<div class="small muted">数据：${esc(x.benchmark)}</div>` : ''}</div>`;
  const edits = (j.edits || []).map((e, i) => `<div class="edit">
    <div class="edit-h"><span class="pri-n">${e.priority || i + 1}</span><span class="badge pri">${esc(e.type || '')}</span>
      ${e.clip ? `<button type="button" class="cref" data-seek="${esc(e.clip)}">${esc(e.clip)}</button>` : ''}<span class="small muted">${esc(e.target || '')}</span>
      <span class="grow"></span>${e.expected ? `<span class="small" style="color:var(--ok)">${esc(e.expected)}</span>` : ''}</div>
    ${e.current || e.change ? `<div class="diff"><div><span>原</span>${esc(e.current || '—')}</div><div><span>改</span>${esc(e.change || '—')}</div></div>` : ''}
    ${e.reason ? `<div class="small muted">理由：${esc(e.reason)}</div>` : ''}
    ${e.prompt ? `<div class="gen"><div class="row"><b class="small">视频生成提示词</b><span class="grow"></span>
      <button type="button" class="btn sm" data-copyp="${i}" data-lang="cn">复制中文</button>
      ${e.prompt_en ? `<button type="button" class="btn sm" data-copyp="${i}" data-lang="en">Copy EN</button>` : ''}</div>
      <pre class="efd-prompt">${esc(e.prompt)}</pre></div>` : ''}</div>`).join('');
  return `${pred}${basis}
    ${funnel ? `<div class="sec-h">效果漏斗诊断 <span class="small muted">EFD-7，按对效果的影响力从上到下</span></div>${funnel}` : ''}
    <div class="mods two">
      ${box('<span style="color:var(--ok)">拉高效果的因素</span>', (j.positives || []).map(factor).join(''))}
      ${box('<span style="color:var(--bad)">拖累效果的因素</span>', (j.negatives || []).map(factor).join(''))}
    </div>
    ${edits ? `<div class="sec-h">微调方案 <span class="small muted">只改关键分镜，不重做；提示词继承原片人物/商品/场景/灯光</span>
      <span class="grow"></span><button type="button" class="btn sm" data-act="copyedits">复制全部方案</button></div>${edits}` : ''}
    ${(j.keep || []).length ? `<div class="sec-h">保持不动</div><div class="chips">${j.keep.map((k) => `<span class="chip">${esc(txt(k))}</span>`).join('')}</div>` : ''}`;
}

function undMarkdown(u) {
  const f = u.fact || {}, g = u.cognition || {}, j = u.judgment || {}, p = j.prediction || {};
  const L = [`# 素材理解`, '', `## 事实层`, f.overview || '', ''];
  (f.clips || []).forEach((c) => L.push(`- **${c.id} ${tRange(c)}** ${[c.shot_size, c.angle, c.movement].filter(Boolean).join('/')}｜${c.subject || ''} ${c.action || ''}｜灯光 ${c.lighting || '-'}｜台词 ${c.dialogue || '-'}｜字幕 ${c.subtitle || '-'}｜转场 ${c.transition_in || '-'}`));
  L.push('', '## 认知层', `- 定位：${(g.positioning || {}).one_liner || ''}`, `- 核心吸引力：${txt(g.core_attraction)}`,
    `- 主卖点：${txt((g.selling_points || {}).primary)}`, `- 买点：${txt(g.buying_points)}`, `- 说服：${txt(g.persuasion)}`);
  (g.clip_roles || []).forEach((r) => L.push(`- ${r.clip} [${r.role}] ${r.function || ''}｜${r.mechanism || ''}｜复用：${r.reuse || ''}`));
  L.push('', '## 判断层', `- 预估：档位 ${p.spend_tier || '-'}，ROAS ${p.roas_low ?? '-'}–${p.roas_high ?? '-'}（${p.vs_baseline || ''}均值，置信度 ${p.confidence ?? '-'}）`, p.summary || '');
  (j.negatives || []).forEach((x) => L.push(`- 拖累：${x.factor}（${txt(x.clips)}）${x.evidence || ''}`));
  (j.edits || []).forEach((e, i) => L.push('', `### 修改 ${e.priority || i + 1}：${e.type || ''} ${e.clip || ''} ${e.target || ''}`,
    `- 原：${e.current || ''}`, `- 改：${e.change || ''}`, `- 理由：${e.reason || ''}`, e.prompt ? `- 提示词：${e.prompt}` : '', e.prompt_en ? `- Prompt: ${e.prompt_en}` : ''));
  return L.filter((x) => x !== undefined).join('\n');
}

function undHtml(u, sub) {
  const S = [['fact', '事实层', '只陈述事实'], ['cog', '认知层', '广告机制'], ['judge', '判断层', '效果与微调']];
  return `<div class="subtabs">${S.map(([k, n, d]) => `<button type="button" data-sub="${k}" class="${k === sub ? 'on' : ''}"><b>${n}</b><small>${d}</small></button>`).join('')}
      <span class="grow"></span><button type="button" class="btn sm ghost" data-act="copyund">复制理解（Markdown）</button></div>
    ${u.legacy ? '<div class="small" style="color:var(--warn);margin-bottom:8px">这是旧版理解稿，点「AI 重新识别」生成三层碎镜拆解。</div>' : ''}
    <div class="subpane" data-subpane="fact" ${sub === 'fact' ? '' : 'hidden'}>${factHtml(u)}</div>
    <div class="subpane" data-subpane="cog" ${sub === 'cog' ? '' : 'hidden'}>${cogHtml(u)}</div>
    <div class="subpane" data-subpane="judge" ${sub === 'judge' ? '' : 'hidden'}>${judgeHtml(u)}</div>`;
}

class Editor {
  constructor(asset, root, opts = {}) {
    this.a = asset;
    this.root = root;
    this.opts = opts;
    this.values = clone(asset.values) || {};
    this.tags = clone(asset.ai_tags) || [];
    this.understanding = asset.understanding || (asset.ai_raw && asset.ai_raw.understanding) || null;
    this.preview = debounce(() => this.refreshNames(), 120);
    this.render();
  }

  mediaSrc() {
    const a = this.a;
    return a.file_path && (a.file_path.startsWith('blob:') || a.demo) ? a.file_path : a.file_path ? `/files/${a.id}` : '';
  }

  mediaHtml() {
    const a = this.a;
    const src = this.mediaSrc();
    if (src) {
      if (a.media_type === 'video') return `<video src="${esc(src)}" controls muted playsinline poster="${a.thumb || ''}"></video>`;
      return `<img src="${esc(src)}">`;
    }
    return a.thumb ? `<img src="${a.thumb}">` : `<div class="ph">无预览</div>`;
  }

  fieldRow(f) {
    const v = this.values[f.key];
    const conf = v && v.confidence != null ? `<span class="badge ${v.confidence >= 0.7 ? 'ok' : 'new'}">${Math.round(v.confidence * 100)}%</span>` : '';
    const src = v && v.source === 'ai' ? '<span class="badge ai">AI</span>' : '';
    const reason = v && v.reason ? `<span class="reason" title="${esc(v.reason)}">${esc(v.reason)}</span>` : '';
    let ctl = '';
    if (f.type === 'enum') {
      const known = v && v.value_id && f.values.some((x) => x.id === v.value_id);
      let opts = `<option value="">（不填）</option>` + f.values.map((x) =>
        `<option value="${x.id}" ${known && x.id === v.value_id ? 'selected' : ''}>${esc(x.cn)} / ${esc(x.en)}  [${esc(x.code)}]</option>`).join('');
      if (v && !known) opts += `<option value="__cur" selected>★ 新值：${esc(v.cn)} / ${esc(v.en)} [${esc(v.code)}]</option>`;
      opts += `<option value="__custom">＋ 自定义新值…</option>`;
      ctl = `<select data-k="${f.key}" data-act="enum">${opts}</select>`;
      if (v && !known) ctl += `<span class="badge new">知识库外</span><button class="btn sm" data-k="${f.key}" data-act="addvalue">加入知识库</button>`;
    } else if (f.type === 'product') {
      const p = PRODUCTS.find((x) => String(x.id) === String(v && v.product_id));
      ctl = `<select data-k="${f.key}" data-act="product" style="max-width:340px">${productOptions(v && v.product_id)}</select>`;
      if (p && p.image_url) ctl += `<span class="ptag"><img src="${esc(p.image_url)}"></span>`;
      ctl += `<input data-k="${f.key}" data-act="spu" placeholder="或手动填写 SPU" value="${esc(v && !v.product_id ? v.spu : '')}" style="width:150px">`;
    } else if (f.type === 'date') {
      ctl = `<input data-k="${f.key}" data-act="date" value="${esc(v && v.date || '')}" placeholder="YYMMDD" maxlength="6" style="width:90px" class="mono">
        <button class="btn sm" data-k="${f.key}" data-act="today">今天</button>`;
    } else if (f.type === 'version') {
      ctl = `<span>V</span><input type="number" min="1" max="35" data-k="${f.key}" data-act="version" value="${esc(v && v.n || '')}" style="width:70px">`;
    } else if (f.type === 'text') {
      ctl = `<input data-k="${f.key}" data-act="text" value="${esc(v && v.text || '')}" style="width:240px">`;
    } else if (f.type === 'ai_tags') {
      return `<div class="frow"><div class="fl">${esc(f.name_cn)} <span class="badge ai">AI</span></div><div>
        <div class="chips">${this.tags.map((t, i) => `<span class="chip ${t.enabled === false ? 'off' : ''}">
          <input type="checkbox" data-i="${i}" data-act="tagon" ${t.enabled === false ? '' : 'checked'} title="勾选=写入命名">
          <span class="cat">${esc(t.category || '其他')}</span>${esc(t.cn)}<span class="muted">/${esc(t.en)}</span>
          <button data-i="${i}" data-act="tagedit" title="编辑">✎</button><button data-i="${i}" data-act="tagdel" title="删除">✕</button></span>`).join('')}
          <button class="btn sm" data-act="tagadd">＋ 标签</button></div>
        <div class="small muted" style="margin-top:4px">勾选的前 ${ST.settings.ai_tags_max} 个写入完整命名${ST.settings.ai_tags_in_name === '1' ? '' : '（当前设置为不写入命名，仅用于分析）'}；全部标签都参与数据分析。</div></div></div>`;
    }
    return `<div class="frow"><div class="fl">${esc(f.name_cn)}${f.in_short ? ' <span class="badge pri" title="参与短名称编码">短</span>' : ''}</div>
      <div class="fctl">${ctl}${src}${conf}${reason}</div></div>`;
  }

  render() {
    const a = this.a, u = this.understanding;
    const tab = Editor.tab || 'und', sub = Editor.sub || 'fact';
    const nClips = u && u.fact ? (u.fact.clips || []).length : 0;
    const pred = u && u.judgment && u.judgment.prediction;
    this.root.innerHTML = `<div class="vx">
      <div class="vx-side">
        <div class="ed-media">${this.mediaHtml()}</div>
        ${u ? timelineHtml(u) : ''}
        <div class="ed-desc"><b>${esc(a.filename)}</b>${a.size ? ' · ' + (a.size / 1048576).toFixed(1) + 'MB' : ''}${nClips ? ` · ${nClips} 个分镜` : ''}</div>
        <div class="ed-desc">${esc((u && u.one_liner) || a.description || '')}</div>
        <div class="vx-sum">
          <div><span>短名称</span><code class="short" data-r="short2">${esc(a.short_name || '—')}</code></div>
          ${pred && pred.spend_tier ? `<div><span>效果预估</span><b>${esc(pred.spend_tier)}</b> 档 · ROAS ${pred.roas_low ?? '-'}–${pred.roas_high ?? '-'}</div>` : ''}
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn sm" data-act="reanalyze">↻ AI 重新识别</button>
          ${a.file_path && !String(a.file_path).startsWith('blob:') ? `<a class="btn sm" href="/files/${a.id}?download=1">⬇ 下载（已重命名）</a>` : ''}
        </div>
      </div>
      <div class="vx-main">
        <div class="vx-tabs">
          <button type="button" data-tab="und" class="${tab === 'und' ? 'on' : ''}">内容理解<small>事实 · 认知 · 判断</small></button>
          <button type="button" data-tab="name" class="${tab === 'name' ? 'on' : ''}">素材命名<small>知识库规范</small></button>
        </div>
        <div class="pane" data-pane="und" ${tab === 'und' ? '' : 'hidden'}>${u ? undHtml(u, sub) : '<div class="empty">暂无理解结果，点左侧「AI 重新识别」</div>'}</div>
        <div class="pane" data-pane="name" ${tab === 'name' ? '' : 'hidden'}>
          <div class="names">
            <div class="nm"><span>完整命名</span><code data-r="full"></code><button class="btn sm" data-act="copyfull">复制</button></div>
            <div class="nm"><span>短名称</span><code class="short" data-r="short"></code><button class="btn sm" data-act="copyshort">复制</button>
              <span class="small muted" data-r="len"></span></div>
            <div class="small" data-r="dup" style="color:var(--warn)"></div>
          </div>
          <div data-r="fields">${ST.fields.map((f) => this.fieldRow(f)).join('')}</div>
          <div class="frow"><div class="fl">媒体素材ID</div><div class="fctl"><input data-act="media" style="flex:1" placeholder="Meta creative id / video id / image hash，多个用逗号分隔（可选，导入数据时会自动学习）" value="${esc((a.media_ids || []).join(','))}"></div></div>
          <div class="row" style="margin-top:12px">
            <span class="grow"></span>
            <span class="small muted" data-r="saved">${a.status === 'named' ? '已保存' : '未保存'}</span>
            <button class="btn pri" data-act="save">保存命名</button>
          </div>
        </div>
      </div></div>`;
    this.root.onchange = (e) => this.onChange(e);
    this.root.oninput = (e) => { if (['date', 'version', 'text', 'spu'].includes(e.target.dataset.act)) this.onChange(e); };
    this.root.onclick = (e) => this.onClick(e);
    const v = $('video', this.root);
    if (v) v.ontimeupdate = () => this.onTime(v.currentTime);
    this.setNames(a.full_name, a.short_name, []);
    this.refreshNames();
  }

  clipById(id) { return ((this.understanding && this.understanding.fact && this.understanding.fact.clips) || []).find((c) => c.id === id); }

  seek(id) {
    const c = this.clipById(id);
    if (!c) return;
    const v = $('video', this.root);
    if (v && c.start != null) { v.pause(); v.currentTime = c.start + Math.min(0.05, (c.end - c.start) / 2); }
    this.activate(id, true);
  }

  onTime(t) {
    const clips = (this.understanding && this.understanding.fact && this.understanding.fact.clips) || [];
    const last = clips[clips.length - 1];
    const head = $('[data-r=playhead]', this.root);
    if (head && last && last.end) head.style.left = `${Math.min(100, t / last.end * 100)}%`;
    const c = clips.find((x) => t >= x.start && t < x.end);
    if (c && c.id !== this.activeClip) this.activate(c.id, false);
  }

  activate(id, scroll) {
    this.activeClip = id;
    $$('[data-clip]', this.root).forEach((el) => el.classList.toggle('on', el.dataset.clip === id));
    $$('.clips', this.root).forEach((strip) => {
      const card = strip.querySelector(`[data-clip="${id}"]`);
      if (card && strip.offsetParent && (scroll || card.offsetLeft < strip.scrollLeft || card.offsetLeft + card.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
        strip.scrollTo({ left: card.offsetLeft - 8, behavior: 'smooth' });
      }
    });
  }

  rerenderFields() { $('[data-r=fields]', this.root).innerHTML = ST.fields.map((f) => this.fieldRow(f)).join(''); this.preview(); }

  setNames(full, short, dup) {
    $('[data-r=full]', this.root).textContent = full || '—';
    $('[data-r=short]', this.root).textContent = short || '—';
    $('[data-r=short2]', this.root).textContent = short || '—';
    $('[data-r=len]', this.root).textContent = `完整 ${full ? full.length : 0} 字符 · 短名 ${short ? short.length : 0} 字符`;
    $('[data-r=dup]', this.root).textContent = dup && dup.length ? `⚠ 与已有素材完整命名重复（${dup.map((d) => d.short_name).join('、')}），建议调整版本号` : '';
  }

  async refreshNames() {
    try {
      const r = await api('POST', '/api/names/preview', { id: this.a.id, seq: this.a.seq, values: this.values, ai_tags: this.tags });
      this.setNames(r.full_name, r.short_name, r.duplicates);
    } catch (e) { fail(e); }
  }

  markDirty() { $('[data-r=saved]', this.root).textContent = '有未保存的修改'; this.preview(); }

  onChange(e) {
    const t = e.target, k = t.dataset.k, act = t.dataset.act;
    const f = ST.fields.find((x) => x.key === k);
    if (act === 'enum') {
      if (t.value === '__custom') {
        const cn = prompt(`为「${f.name_cn}」输入新的中文值`);
        if (!cn) { this.rerenderFields(); return; }
        const en = prompt('英文值（用于命名，PascalCase）；留空则自动翻译补全', '') || '';
        this.values[k] = { value_id: null, cn, en: en.replace(/\s+/g, ''), code: '', is_new: true, source: 'manual' };
        this.addValue(k, true);
        return;
      }
      if (t.value === '__cur') return;
      const v = f.values.find((x) => String(x.id) === t.value);
      this.values[k] = v ? { value_id: v.id, cn: v.cn, en: v.en, code: v.code, source: 'manual' } : null;
      this.rerenderFields();
    } else if (act === 'product') {
      const p = PRODUCTS.find((x) => String(x.id) === t.value);
      this.values[k] = p ? { product_id: p.id, spu: p.spu, title: p.title, source: 'manual' } : null;
      this.rerenderFields();
    } else if (act === 'spu') {
      this.values[k] = t.value.trim() ? { product_id: null, spu: t.value.trim(), source: 'manual' } : null;
      const sel = $(`select[data-act=product][data-k="${k}"]`, this.root);
      if (sel) sel.value = '';
    } else if (act === 'date') {
      const d = t.value.replace(/\D/g, '').slice(0, 6);
      this.values[k] = d ? { date: d, source: 'manual' } : null;
    } else if (act === 'version') {
      this.values[k] = t.value ? { n: parseInt(t.value, 10), source: 'manual' } : null;
    } else if (act === 'text') {
      this.values[k] = t.value ? { text: t.value, source: 'manual' } : null;
    } else if (act === 'tagon') {
      this.tags[+t.dataset.i].enabled = t.checked;
      this.rerenderFields();
    } else if (act === 'media') {
      // 保存时读取
    }
    this.markDirty();
  }

  async addValue(k, silentRerender) {
    const f = ST.fields.find((x) => x.key === k);
    const v = this.values[k];
    try {
      const st = await api('POST', `/api/fields/${f.id}/values`, { cn: v.cn, en: v.en, code: v.code || '', source: v.source === 'ai' ? 'ai' : 'manual' });
      await loadState(st);
      const nv = st.created;
      this.values[k] = { value_id: nv.id, cn: nv.cn, en: nv.en, code: nv.code, source: v.source, confidence: v.confidence, reason: v.reason };
      toast(`已加入知识库：${f.name_cn} → ${nv.cn} / ${nv.en} [${nv.code}]`, 'ok');
    } catch (e) {
      // 短码冲突时让后端自动生成
      if (v.code) { v.code = ''; return this.addValue(k, silentRerender); }
      fail(e);
    }
    this.rerenderFields();
    this.markDirty();
  }

  switchTab(attr, key) {
    if (attr === 'tab') {
      Editor.tab = key;
      $$('.vx-tabs [data-tab]', this.root).forEach((x) => x.classList.toggle('on', x.dataset.tab === key));
      $$('[data-pane]', this.root).forEach((x) => { x.hidden = x.dataset.pane !== key; });
    } else {
      Editor.sub = key;
      $$('.subtabs [data-sub]', this.root).forEach((x) => x.classList.toggle('on', x.dataset.sub === key));
      $$('[data-subpane]', this.root).forEach((x) => { x.hidden = x.dataset.subpane !== key; });
    }
    if (this.activeClip) this.activate(this.activeClip, true);
  }

  async onClick(e) {
    const nav = e.target.closest('[data-tab],[data-sub],[data-seek],[data-copyp]');
    if (nav) {
      if (nav.dataset.tab) return this.switchTab('tab', nav.dataset.tab);
      if (nav.dataset.sub) return this.switchTab('sub', nav.dataset.sub);
      if (nav.dataset.seek) return this.seek(nav.dataset.seek);
      const ed = ((this.understanding && this.understanding.judgment && this.understanding.judgment.edits) || [])[+nav.dataset.copyp];
      if (ed) copy(nav.dataset.lang === 'en' ? ed.prompt_en : ed.prompt);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    const act = b.dataset.act;
    if (act === 'copyfull') copy($('[data-r=full]', this.root).textContent);
    if (act === 'copyshort') copy($('[data-r=short]', this.root).textContent);
    if (act === 'copyund' && this.understanding) copy(undMarkdown(this.understanding));
    if (act === 'copyedits' && this.understanding) {
      const md = undMarkdown(this.understanding);
      copy(md.slice(md.indexOf('## 判断层')));
    }
    if (act === 'addvalue') this.addValue(b.dataset.k);
    if (act === 'today') {
      const d = new Date();
      const s = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      this.values[b.dataset.k] = { date: s, source: 'manual' };
      $(`input[data-act=date][data-k="${b.dataset.k}"]`, this.root).value = s;
      this.markDirty();
    }
    if (act === 'tagdel') { this.tags.splice(+b.dataset.i, 1); this.rerenderFields(); this.markDirty(); }
    if (act === 'tagedit' || act === 'tagadd') {
      const t = act === 'tagedit' ? this.tags[+b.dataset.i] : { category: '', cn: '', en: '', enabled: true };
      const category = prompt('标签分类（如：人物、主色调、开头钩子）', t.category || '');
      if (category === null) return;
      const cn = prompt('中文标签', t.cn || '');
      if (!cn) return;
      const en = prompt('英文标签（写入命名，PascalCase）', t.en || '') || cn;
      Object.assign(t, { category: category || '其他', cn, en: en.replace(/\s+/g, '') });
      if (act === 'tagadd') this.tags.push(t);
      this.rerenderFields(); this.markDirty();
    }
    if (act === 'reanalyze') this.reanalyze(b);
    if (act === 'save') this.save(b);
  }

  async reanalyze(btn) {
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 切镜与识别中…';
    try {
      let ex = this.opts.ex;
      if ((!ex || !ex.frames.length) && this.mediaSrc()) {
        try { ex = this.opts.ex = await extractFrames(this.mediaSrc(), this.a.media_type); } catch (err) { toast(err.message); }
      }
      if (!ex || !ex.frames.length) ex = { frames: this.a.thumb ? [this.a.thumb] : [], clips: [] };
      const a = await api('POST', `/api/assets/${this.a.id}/analyze`, analyzeBody(ex));
      if (a.mode === 'offline') toast('未配置 AI Key，仅按文件名/类型预填');
      this.a = a; this.values = clone(a.values); this.tags = clone(a.ai_tags);
      this.understanding = a.understanding || (a.ai_raw && a.ai_raw.understanding) || null;
      this.render();
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = '↻ AI 重新识别'; }
  }

  async save(btn) {
    btn.disabled = true;
    try {
      const a = await api('PUT', `/api/assets/${this.a.id}`, {
        values: this.values, ai_tags: this.tags, media_ids: $('[data-act=media]', this.root).value,
      });
      this.a = a;
      $('[data-r=saved]', this.root).textContent = '已保存 ✓';
      toast((STATIC_DEMO ? '演示已保存（仅本页会话）：' : '已保存：') + a.short_name, 'ok');
      if (this.opts.onSaved) this.opts.onSaved(a);
    } catch (e) { fail(e); }
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ 页面：上传 */

const QUEUE = [];

function pageUpload(main) {
  const demoNote = STATIC_DEMO
    ? `<div class="card" style="border-color:#c9cdf3;background:#f7f8ff">在线演示：真实执行<b>浏览器自动切镜</b>，理解内容为模拟数据（不调用真实 AI、不落库）。可点「试用演示视频」或自行上传。</div>`
    : (ST.settings.ai_api_key_set ? '<div class="card" style="border-color:#cfe9d8;background:#f1faf5">已配置 AI：上传后自动切镜 → 事实层 → 认知层 → 命名 → 判断层（结合历史投放数据）。方法论见仓库 <code>methodology.md</code>。</div>'
      : '<div class="card" style="border-color:#f5d48a;background:#fffaf0">尚未配置 AI Key：上传后只会自动切镜并预填命名字段。请到 <a href="#/settings">设置</a> 填写 OpenAI 兼容接口以启用三层理解。</div>');
  main.innerHTML = `<h1>上传素材 &amp; AI 理解 / 命名</h1>
    <p class="sub">视频先按画面突变自动切成碎镜，AI 再逐镜做三层理解：<b>事实层</b>（编导视角，只记录）→ <b>认知层</b>（广告机制，只分析）→ <b>判断层</b>（结合历史数据预估效果，给出分镜级微调与生成提示词）；命名基于理解结果与知识库。</p>
    ${demoNote}
    ${!STATIC_DEMO && !PRODUCTS.length ? '<div class="card" style="border-color:#f5d48a;background:#fffaf0">商品库为空：AI 无法识别 SPU。请先到 <a href="#/products">商品库</a> 同步 Shopify / Meta 目录。</div>' : ''}
    <div class="row" style="margin-bottom:12px">
      ${STATIC_DEMO ? '<button class="btn pri" id="demoTrialVid">试用演示视频</button><button class="btn" id="demoTrial">试用演示图片</button>' : ''}
      <span class="small muted">${STATIC_DEMO ? '或自行上传图片 / 视频 / GIF' : ''}</span>
    </div>
    <div class="drop" id="drop"><b>拖拽图片 / 视频 / GIF 到这里</b><div class="muted">或点击选择文件，可多选</div>
      <input type="file" id="fileIn" multiple accept="image/*,video/*" hidden></div>
    <div id="queue" style="margin-top:18px"></div>`;
  const drop = $('#drop'), fileIn = $('#fileIn');
  drop.onclick = () => fileIn.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  fileIn.onchange = () => { addFiles(fileIn.files); fileIn.value = ''; };
  const trial = $('#demoTrial');
  if (trial) trial.onclick = () => demoTrialUpload();
  const trialV = $('#demoTrialVid');
  if (trialV) trialV.onclick = () => demoTrialVideo(trialV);
  QUEUE.forEach(renderQueueItem);
}

async function demoTrialVideo(btn) {
  const cv = document.createElement('canvas');
  cv.width = 360; cv.height = 640;
  const types = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
  const mime = window.MediaRecorder && types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime || !cv.captureStream) { toast('当前浏览器不支持生成演示视频，改用演示图片'); return demoTrialUpload(); }
  const p = PRODUCTS[0] || { spu: 'FI-20250489' };
  const shots = [['#e5484d', '还在为这个烦恼？', 1.6], ['#f08c00', '使用前', 1.4], ['#4f5bd5', `${p.spu} 细节`, 2.2], ['#2f80ed', '前后对比', 1.6], ['#12a36b', '一整天都舒服', 1.6], ['#8e44ad', '点击查看同款 →', 1.8]];
  const total = shots.reduce((s, x) => s + x[2], 0);
  btn.disabled = true; btn.textContent = `生成演示视频中（${Math.ceil(total)}s）…`;
  const g = cv.getContext('2d');
  const rec = new MediaRecorder(cv.captureStream(30), { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start(200);
  const t0 = performance.now();
  await new Promise((res) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= total) return res();
      let acc = 0, i = 0;
      while (i < shots.length - 1 && t >= acc + shots[i][2]) acc += shots[i++][2];
      const [col, text] = shots[i], k = (t - acc) / shots[i][2];
      g.fillStyle = col; g.fillRect(0, 0, 360, 640);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(180 + 60 * Math.sin(k * 3), 330, 90 + 20 * k, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 28px sans-serif'; g.textAlign = 'center'; g.fillText(text, 180, 120);
      g.font = '16px sans-serif'; g.fillText(`Shot ${i + 1}/${shots.length}`, 180, 600);
      requestAnimationFrame(draw);
    };
    draw();
  });
  rec.stop();
  await done;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  addFiles([new File([new Blob(chunks, { type: mime.split(';')[0] })], `${p.spu}_Shoot-MP_demo.${ext}`, { type: mime.split(';')[0] })]);
  btn.disabled = false; btn.textContent = '试用演示视频';
  toast('演示视频已生成，正在自动切镜与识别…', 'ok');
}

async function demoTrialUpload() {
  const p = PRODUCTS[0] || { spu: 'FI-20250489', title: 'Demo Product' };
  const cv = document.createElement('canvas');
  cv.width = 640; cv.height = 800;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 800);
  grd.addColorStop(0, '#6c5ce7'); grd.addColorStop(1, '#00b894');
  g.fillStyle = grd; g.fillRect(0, 0, 640, 800);
  g.fillStyle = '#fff'; g.font = 'bold 42px sans-serif'; g.fillText(p.spu, 48, 120);
  g.font = '28px sans-serif'; g.fillText(String(p.title || '').slice(0, 28), 48, 180);
  g.font = '20px sans-serif'; g.fillText('Creative Insights Demo', 48, 240);
  const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
  const file = new File([blob], `${p.spu}_Shoot-MP_demo.jpg`, { type: 'image/jpeg' });
  addFiles([file]);
  toast('已加入演示素材，正在识别命名…', 'ok');
}

function addFiles(list) {
  for (const file of list) {
    if (!/^(image|video)\//.test(file.type)) { toast('跳过不支持的文件：' + file.name); continue; }
    const item = { id: Math.random().toString(36).slice(2), file, status: '准备中', asset: null };
    QUEUE.unshift(item);
    renderQueueItem(item, true);
  }
  pumpQueue();
}

let running = 0;
async function pumpQueue() {
  while (running < 2) {
    const item = QUEUE.slice().reverse().find((x) => x.status === '准备中');
    if (!item) return;
    running++;
    processItem(item).finally(() => { running--; pumpQueue(); });
  }
}

function setItem(item, status) { item.status = status; renderQueueItem(item); }

async function processItem(item) {
  const f = item.file;
  const mtype = f.type === 'image/gif' ? 'gif' : f.type.startsWith('video') ? 'video' : 'image';
  try {
    setItem(item, '抽取画面');
    const url = URL.createObjectURL(f);
    let ex = { frames: [], thumb: null, clips: [] };
    try { ex = await extractFrames(url, mtype, (s) => setItem(item, s)); } catch (e) { toast(f.name + '：' + e.message); }
    item.ex = ex;
    setItem(item, '上传中');
    const a = await api('POST', `/api/assets/upload?filename=${encodeURIComponent(f.name)}&media_type=${mtype}`, f, { raw: true });
    setItem(item, `AI 三层理解中（${ex.clips.length || 1} 个分镜）`);
    item.asset = await api('POST', `/api/assets/${a.id}/analyze`, analyzeBody(ex));
    setItem(item, '待确认');
  } catch (e) {
    item.error = e.message;
    setItem(item, '失败');
  }
  loadState().catch(() => {});
}

function renderQueueItem(item, prepend) {
  const q = $('#queue');
  if (!q) return;
  let el = document.getElementById('q_' + item.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'card qitem';
    el.id = 'q_' + item.id;
    prepend ? q.prepend(el) : q.appendChild(el);
  }
  const busy = ['准备中', '抽取画面', '智能切镜', '上传中'].includes(item.status) || item.status.startsWith('AI ');
  if (item.asset && !busy) {
    if (!el.dataset.ed) {
      const badge = item.asset.mode === 'offline' ? '已预填' : item.asset.mode === 'demo' ? '演示识别' : 'AI 已识别';
      el.innerHTML = `<div class="qhead"><b>${esc(item.file.name)}</b><span class="badge ok">${badge}</span>
        <span class="grow"></span><button class="btn sm ghost" data-rm>移出列表</button></div><div class="edroot"></div>`;
      el.dataset.ed = '1';
      new Editor(item.asset, $('.edroot', el), { ex: item.ex, onSaved: (a) => { item.asset = a; } });
      $('[data-rm]', el).onclick = () => { QUEUE.splice(QUEUE.indexOf(item), 1); el.remove(); };
    }
    return;
  }
  el.innerHTML = `<div class="qhead"><b>${esc(item.file.name)}</b>
    ${busy ? `<span class="spin"></span><span class="muted">${item.status}…</span>` : `<span class="badge bad">${esc(item.status)}</span><span class="small" style="color:var(--bad)">${esc(item.error || '')}</span>`}</div>`;
}

/* ------------------------------------------------------------------ 页面：素材库 */

async function pageAssets(main) {
  const assets = await api('GET', '/api/assets');
  main.innerHTML = `<h1>素材库</h1><p class="sub">所有已命名素材。投放时在 Ad Name 中使用「短名称」，数据回流时据此还原完整标签。</p>
    <div class="card"><div class="row">
      <input id="aq" placeholder="搜索 完整命名 / 短名称 / 文件名" class="grow">
      <button class="btn" id="rebuild" title="知识库的值或命名格式修改后，按最新规范刷新所有素材的命名（短名称流水号不变，已投放广告仍可匹配）">按最新规范刷新命名</button>
      <a class="btn" href="/api/assets/export.csv">导出命名表 CSV</a>
    </div></div>
    <div class="card" style="padding:6px 8px"><table class="t"><thead><tr><th></th><th>短名称</th><th>完整命名</th><th>AI 标签</th><th>媒体ID</th><th>状态</th><th></th></tr></thead>
    <tbody id="atb"></tbody></table>${assets.length ? '' : '<div class="empty">还没有素材，去 <a href="#/upload">上传</a> 吧</div>'}</div>`;
  const draw = () => {
    const kw = $('#aq').value.trim().toLowerCase();
    $('#atb').innerHTML = assets.filter((a) => !kw || [a.full_name, a.short_name, a.filename].some((x) => (x || '').toLowerCase().includes(kw))).map((a) => `
      <tr><td>${a.thumb ? `<img class="th" src="${a.thumb}">` : '<div class="th"></div>'}</td>
      <td><code class="mono" style="color:var(--pri);font-weight:600">${esc(a.short_name)}</code> <button class="btn sm ghost" data-copy="${esc(a.short_name)}">⧉</button></td>
      <td class="mono small" style="word-break:break-all;max-width:420px">${esc(a.full_name)}</td>
      <td><div class="tagline">${a.ai_tags.filter((t) => t.enabled !== false).map((t) => `<span class="badge ai">${esc(t.cn)}</span>`).join('')}</div></td>
      <td class="small muted">${a.media_ids.length ? a.media_ids.length + ' 个' : '-'}</td>
      <td>${a.status === 'named' ? '<span class="badge ok">已命名</span>' : '<span class="badge new">待确认</span>'}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-edit="${a.id}">编辑</button>
        ${a.file_path ? `<a class="btn sm" href="/files/${a.id}?download=1">下载</a>` : ''}
        <button class="btn sm danger" data-del="${a.id}">删除</button></td></tr>`).join('');
  };
  draw();
  $('#aq').oninput = draw;
  $('#atb').onclick = async (e) => {
    const t = e.target;
    if (t.dataset.copy) copy(t.dataset.copy);
    if (t.dataset.edit) {
      const a = await api('GET', '/api/assets/' + t.dataset.edit);
      const box = document.createElement('div');
      openModal('编辑命名 · ' + a.short_name, box);
      new Editor(a, box, { onSaved: (na) => { Object.assign(assets.find((x) => x.id === na.id), na); draw(); } });
    }
    if (t.dataset.del && confirm('确定删除该素材？已投放广告将无法再按短名称还原标签。')) {
      await api('DELETE', '/api/assets/' + t.dataset.del).catch(fail);
      assets.splice(assets.findIndex((x) => String(x.id) === t.dataset.del), 1);
      draw(); loadState();
    }
  };
  $('#rebuild').onclick = async () => {
    if (!confirm('按当前知识库刷新全部 ' + assets.length + ' 个素材的命名？')) return;
    try { const r = await api('POST', '/api/assets/rebuild', {}); toast(`已刷新 ${r.updated} 个素材`, 'ok'); route(); } catch (e) { fail(e); }
  };
}

/* ------------------------------------------------------------------ 页面：命名规范 */

function formatPreviewHtml() {
  const sep = esc(ST.settings.separator);
  const segs = ST.fields.filter((f) => f.type !== 'ai_tags' || ST.settings.ai_tags_in_name === '1')
    .map((f) => `<span class="seg">${esc(f.name_cn)}</span>`).join(`<span class="sep">${sep}</span>`);
  const lay = ST.short_layout.map((l) => `<span class="seg">${esc(l.name)}<small>${l.width}位</small></span>`).join('');
  return `<div class="fmt">
    <div class="fmt-line"><span class="fmt-k">完整命名</span><div>${segs}</div></div>
    <div class="fmt-line ex"><span class="fmt-k"></span><code data-ex="full">…</code></div>
    <div class="fmt-line"><span class="fmt-k">短名称</span><div>${lay || '<span class="muted">（没有字段勾选「短」）</span>'}<span class="seg opt">重名时 +1位字母</span></div></div>
    <div class="fmt-line ex"><span class="fmt-k"></span><code data-ex="short" class="short">…</code></div></div>`;
}

async function fillExample(root) {
  const values = {};
  for (const f of ST.fields) {
    const v = f.values[0];
    if (f.type === 'product') values[f.key] = { spu: PRODUCTS[0] ? PRODUCTS[0].spu : 'FI-20250489' };
    if (f.type === 'enum' && v) values[f.key] = { value_id: v.id, cn: v.cn, en: v.en, code: v.code };
    if (f.type === 'date') values[f.key] = { date: '260101' };
    if (f.type === 'version') values[f.key] = { n: 1 };
    if (f.type === 'text') values[f.key] = { text: 'Demo' };
  }
  const tags = [{ category: '人物', cn: '女性', en: 'Female' }, { category: '主色调', cn: '黑色', en: 'Black' }];
  const r = await api('POST', '/api/names/preview', { seq: 1, values, ai_tags: tags });
  $('[data-ex=full]', root).textContent = r.full_name;
  $('[data-ex=short]', root).textContent = r.short_name;
}

function pageSpec(main) {
  const s = ST.settings;
  main.innerHTML = `<h1>命名规范（知识库）</h1>
    <p class="sub">维护命名字典（字段 + 可选值）、字段顺序与分隔符。字段和可选值可随时增加；「短码」用于生成可还原的短名称，同一字段内唯一。</p>
    <div class="card"><h3>命名格式</h3>
      <div class="fgroups">
        <div class="fgroup"><h4><span>1</span>完整命名<small>素材文件名 / 素材库展示</small></h4>
          <div class="frm">
            <label>命名语言</label><select data-s="name_lang"><option value="en" ${s.name_lang === 'en' ? 'selected' : ''}>英文</option><option value="cn" ${s.name_lang === 'cn' ? 'selected' : ''}>中文</option></select>
            <label>字段分隔符</label><span><input data-s="separator" value="${esc(s.separator)}" class="mono" style="width:56px;text-align:center"><em>字段之间的连接符号</em></span>
          </div></div>
        <div class="fgroup"><h4><span>2</span>AI 标签<small>规范外的补充标签</small></h4>
          <div class="frm">
            <label>写入命名</label><select data-s="ai_tags_in_name"><option value="1" ${s.ai_tags_in_name === '1' ? 'selected' : ''}>写入</option><option value="0" ${s.ai_tags_in_name !== '1' ? 'selected' : ''}>不写入，仅用于分析</option></select>
            <label>最多写入</label><span><input type="number" min="1" max="10" data-s="ai_tags_max" value="${esc(s.ai_tags_max)}" style="width:56px"><em>个</em></span>
            <label>标签连接符</label><span><input data-s="ai_tag_joiner" value="${esc(s.ai_tag_joiner)}" class="mono" style="width:56px;text-align:center"><em>多个 AI 标签之间，需与字段分隔符不同</em></span>
          </div></div>
        <div class="fgroup"><h4><span>3</span>短名称<small>用于广告 Ad Name，可还原完整标签</small></h4>
          <div class="frm">
            <label>短码位数</label><span><select data-s="code_width">${[1, 2, 3].map((n) => `<option ${String(n) === s.code_width ? 'selected' : ''}>${n}</option>`).join('')}</select><em>每个字典值的编码长度</em></span>
            <label>组成</label><em>勾选「短」的字段按顺序拼接；日期 6 位、版本 V+1 位</em>
            <label>重名区分</label><em>短名称已存在时，末尾自动追加 1 位字母（A、B、C…）</em>
          </div></div>
      </div>
      <div style="margin-top:14px" id="fmtBox">${formatPreviewHtml()}</div>
    </div>
    <div class="card"><div class="row" style="margin-bottom:12px"><h3 style="margin:0">字段与可选值（按命名顺序）</h3>
      <span class="small muted">拖动列头 ⋮⋮ 调整顺序 · 每个值：中文 | 短码，下一行英文（写入命名）· 新增时中英文只填一项即可 · 悬停显示 ⓘ 说明 / ✕ 删除</span><span class="grow"></span>
      ${needsCompletion() ? `<button class="btn" id="completeAll" title="为只有中文或只有英文的值自动补全另一项，并重新生成有含义的短码">补全中英文（${needsCompletion()}）</button>` : ''}
      <button class="btn" id="exportSpec">导出规范 JSON</button><button class="btn" id="importSpec">导入</button><input type="file" id="specFile" accept=".json" hidden></div>
      <div id="fieldList"></div>
      <div class="field-card" style="border-style:dashed"><div class="field-body row" style="padding:12px">
        <b>新增字段</b>
        <input id="nfCn" placeholder="字段名（中文），如：人群" style="width:180px">
        <input id="nfEn" placeholder="英文 key，如 audience" style="width:170px">
        <select id="nfType"><option value="enum">字典（可选值）</option><option value="text">自由文本</option>
          ${ST.fields.some((f) => f.type === 'ai_tags') ? '' : '<option value="ai_tags">AI标签</option>'}
          ${ST.fields.some((f) => f.type === 'version') ? '' : '<option value="version">版本号</option>'}
          ${ST.fields.some((f) => f.type === 'product') ? '' : '<option value="product">商品SPU</option>'}
          <option value="date">日期</option></select>
        <label class="row small"><input type="checkbox" id="nfShort"> 参与短名称</label>
        <button class="btn pri" id="nfAdd">添加字段</button></div></div>
    </div>`;
  fillExample(main).catch(fail);
  drawFields();
  main.onchange = async (e) => {
    const t = e.target;
    if (t.dataset.s) {
      if (t.dataset.s === 'code_width' && !confirm('修改短码位数会让已有短码失效（需在每个字段里重设短码），确定吗？')) { t.value = ST.settings.code_width; return; }
      try { await loadState(await api('PUT', '/api/settings', { [t.dataset.s]: t.value })); $('#fmtBox').innerHTML = formatPreviewHtml(); fillExample(main); } catch (er) { fail(er); }
    }
  };
  $('#nfAdd').onclick = async () => {
    try {
      await loadState(await api('POST', '/api/fields', { name_cn: $('#nfCn').value, name_en: $('#nfEn').value, key: $('#nfEn').value, type: $('#nfType').value, in_short: $('#nfShort').checked }));
      pageSpec(main); toast('已添加字段，可拖到合适的位置', 'ok');
    } catch (e) { fail(e); }
  };
  if ($('#completeAll')) $('#completeAll').onclick = async (e) => {
    const b = e.target; b.disabled = true; b.innerHTML = '<span class="spin"></span> 补全中';
    try {
      const st = await api('POST', '/api/values/complete', {});
      await loadState(st);
      toast(st.changed.length ? '已补全：' + st.changed.map((x) => `${x.cn} → ${x.en} [${x.code}]`).join('，') : '没有可补全的值', 'ok');
      pageSpec(main);
    } catch (er) { fail(er); b.disabled = false; }
  };
  $('#exportSpec').onclick = async () => {
    const data = await api('GET', '/api/spec/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = '命名规范.json'; a.click();
  };
  $('#importSpec').onclick = () => $('#specFile').click();
  $('#specFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!confirm('导入会覆盖当前全部字段与可选值，确定？')) return;
    try { await loadState(await api('POST', '/api/spec/import', JSON.parse(await f.text()))); pageSpec(main); toast('已导入', 'ok'); } catch (er) { fail(er); }
  };
}

const COMPLETE_HOW = { ai: 'AI', translate: '在线翻译', pinyin: '拼音' };
const needsCompletion = () => ST.fields.filter((f) => f.type === 'enum')
  .reduce((n, f) => n + f.values.filter((v) => !v.cn || !v.en || /[\u3400-\u9fff]/.test(v.en)).length, 0);

const FIELD_HINT = {
  product: '取值来自商品库，AI 自动识别，也可手动填写',
  date: '制作日期 YYMMDD，默认上传当天；短名称中占 6 位',
  version: '数字版本号；同 SPU + 同标签组合自动递增；短名称中为 V+1 位',
  ai_tags: 'AI 自由补充，不受字典限制；分析时按标签分类汇总',
  text: '自由文本，由 AI 或人工填写',
};

function drawFields() {
  const box = $('#fieldList');
  const w = +ST.settings.code_width;
  const sep = esc(ST.settings.separator);
  box.className = 'fboard';
  box.innerHTML = ST.fields.map((f, i) => {
    const hasValues = f.type === 'enum';
    const shortable = ['enum', 'date', 'version', 'text'].includes(f.type);
    const inName = f.type !== 'ai_tags' || ST.settings.ai_tags_in_name === '1';
    return `${i ? `<div class="fsep" title="字段分隔符">${sep}</div>` : ''}
    <div class="fcol ${hasValues ? '' : 'narrow'} ${inName ? '' : 'off'}" data-fid="${f.id}">
      <div class="fcol-head">
        <span class="grip" draggable="true" title="按住拖动，左右调整顺序">⋮⋮<b>${i + 1}</b></span>
        <input data-ff="name_cn" value="${esc(f.name_cn)}" class="fname" title="字段名">
        <button class="ibtn danger" data-fdel title="删除字段">✕</button>
      </div>
      <div class="fcol-meta">
        <span class="badge">${TYPE_LABEL[f.type]}</span>
        ${shortable ? `<label title="参与短名称编码"><input type="checkbox" data-ff="in_short" ${f.in_short ? 'checked' : ''}>短</label>` : ''}
        <button class="ibtn ${f.description ? 'on' : ''}" data-fdesc title="${esc(f.description ? '说明：' + f.description : '添加字段说明（提供给 AI 作判断依据）')}">ⓘ</button>
      </div>
      ${hasValues ? `<div class="fvals">
        ${f.values.map((v) => `<div class="vrow" data-vid="${v.id}" title="${esc(v.description ? '说明：' + v.description : '')}">
          <input data-vf="cn" value="${esc(v.cn)}" class="vcn">
          <input data-vf="code" value="${esc(v.code)}" maxlength="${w}" class="vcode mono" title="短码（${w}位）">
          <input data-vf="en" value="${esc(v.en)}" class="ven mono" title="英文（写入命名）">
          <span class="vact">${v.source === 'ai' ? '<i class="vai" title="AI 新增">AI</i>' : ''}<button class="ibtn ${v.description ? 'on' : ''}" data-vdesc title="说明（给 AI 参考）">ⓘ</button><button class="ibtn danger" data-vdel title="删除">✕</button></span>
        </div>`).join('')}
        </div>
        <div class="vrow vnew">
          <input data-nv="cn" placeholder="+ 中文" class="vcn">
          <input data-nv="code" placeholder="自动" maxlength="${w}" class="vcode mono">
          <input data-nv="en" placeholder="English（可空）回车添加" class="ven mono" title="中文、英文只填一项即可，另一项和短码会自动生成">
        </div>` : `<div class="fhint">${FIELD_HINT[f.type] || ''}${inName ? '' : '<br>（当前不写入命名）'}</div>`}
    </div>`;
  }).join('');

  const reload = async (p) => { try { await loadState(await p); drawFields(); $('#fmtBox').innerHTML = formatPreviewHtml(); fillExample($('#main')); } catch (e) { fail(e); drawFields(); } };
  const fidOf = (el) => el.closest('[data-fid]').dataset.fid;
  const addValue = async (row) => {
    const g = (k) => $(`[data-nv=${k}]`, row).value.trim();
    if (!g('cn') && !g('en')) return;
    $$('input', row).forEach((i) => { i.disabled = true; });
    try {
      const st = await api('POST', `/api/fields/${fidOf(row)}/values`, { cn: g('cn'), en: g('en'), code: g('code') });
      if (st.completed) toast(`已自动补全（${COMPLETE_HOW[st.completed]}）：${st.created.cn} / ${st.created.en}，短码 ${st.created.code}`, 'ok');
      reload(Promise.resolve(st));
    } catch (e) { fail(e); drawFields(); }
  };
  box.onchange = (e) => {
    const t = e.target;
    if (t.dataset.ff) reload(api('PUT', '/api/fields/' + fidOf(t), { [t.dataset.ff]: t.type === 'checkbox' ? t.checked : t.value }));
    if (t.dataset.vf) reload(api('PUT', '/api/values/' + t.closest('[data-vid]').dataset.vid, { [t.dataset.vf]: t.value }));
  };
  box.onkeydown = (e) => { if (e.key === 'Enter' && e.target.dataset.nv) addValue(e.target.closest('.vnew')); };
  box.onclick = (e) => {
    const t = e.target.closest('button');
    if (!t || !t.closest('[data-fid]')) return;
    const fid = fidOf(t);
    const f = ST.fields.find((x) => String(x.id) === fid);
    if (t.hasAttribute('data-fdel') && confirm(`删除字段「${f.name_cn}」及其全部可选值？`)) reload(api('DELETE', '/api/fields/' + fid));
    if (t.hasAttribute('data-fdesc')) {
      const d = prompt(`「${f.name_cn}」字段说明（会提供给 AI 作为判断依据）`, f.description || '');
      if (d !== null) reload(api('PUT', '/api/fields/' + fid, { description: d }));
    }
    const vid = t.closest('[data-vid]') && t.closest('[data-vid]').dataset.vid;
    const v = vid && f.values.find((x) => String(x.id) === vid);
    if (t.hasAttribute('data-vdel') && confirm(`删除可选值「${v.cn}」？已使用它的素材保留原命名。`)) reload(api('DELETE', '/api/values/' + vid));
    if (t.hasAttribute('data-vdesc')) {
      const d = prompt(`「${v.cn} / ${v.en}」的说明（给 AI 参考）`, v.description || '');
      if (d !== null) reload(api('PUT', '/api/values/' + vid, { description: d }));
    }
  };

  let dragId = null;
  const clearMarks = () => $$('.fcol', box).forEach((c) => c.classList.remove('drop-before', 'drop-after', 'dragging'));
  const targetOf = (e) => {
    const cols = $$('.fcol', box).filter((c) => c.dataset.fid !== dragId);
    if (!cols.length) return null;
    let best = cols[0], bd = Infinity;
    for (const c of cols) {
      const r = c.getBoundingClientRect();
      const d = Math.abs(e.clientX - (r.left + r.width / 2));
      if (d < bd) { bd = d; best = c; }
    }
    const r = best.getBoundingClientRect();
    return { col: best, after: e.clientX > r.left + r.width / 2 };
  };
  box.ondragstart = (e) => {
    const g = e.target.closest && e.target.closest('.grip');
    if (!g) return;
    const col = g.closest('.fcol');
    dragId = col.dataset.fid;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.setDragImage(col, 20, 16);
    requestAnimationFrame(() => col.classList.add('dragging'));
  };
  box.ondragover = (e) => {
    if (!dragId) return;
    e.preventDefault();
    const t = targetOf(e);
    $$('.fcol', box).forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    if (t) t.col.classList.add(t.after ? 'drop-after' : 'drop-before');
  };
  box.ondrop = (e) => {
    if (!dragId) return;
    e.preventDefault();
    const t = targetOf(e);
    const moving = dragId;
    dragId = null;
    clearMarks();
    if (!t) return;
    const ids = ST.fields.map((f) => String(f.id)).filter((id) => id !== moving);
    ids.splice(ids.indexOf(t.col.dataset.fid) + (t.after ? 1 : 0), 0, moving);
    if (ids.join() === ST.fields.map((f) => String(f.id)).join()) return;
    reload(api('POST', '/api/fields/order', { ids: ids.map(Number) }));
  };
  box.ondragend = () => { dragId = null; clearMarks(); };
}

/* ------------------------------------------------------------------ 页面：商品库 */

function pageProducts(main) {
  const s = ST.settings;
  main.innerHTML = `<h1>商品库</h1><p class="sub">连接 Shopify 网站或 Meta 商品目录，获取商品图与名称，供 AI 识别素材中的商品并写入 SPU。</p>
    <div class="grid2">
      <div class="card"><h3>Shopify 网站</h3><div class="row">
        <input id="shopDomain" class="grow" placeholder="例如 yourstore.com 或 xxx.myshopify.com" value="${esc(s.shopify_domain)}">
        <button class="btn pri" id="syncShop">同步商品</button></div>
        <div class="small muted" style="margin-top:6px">读取店铺公开的 /products.json（无需授权）。SPU 默认取变体 SKU 的公共前缀，可在下方单独修改。</div></div>
      <div class="card"><h3>Meta 商品目录</h3><div class="row">
        <input id="catId" class="grow" placeholder="Catalog ID" value="${esc(s.meta_catalog_id)}">
        <button class="btn pri" id="syncMeta">同步目录</button></div>
        <div class="small muted" style="margin-top:6px">需在 <a href="#/settings">设置</a> 填写 Meta Access Token（catalog_management 权限）。按 retailer_product_group_id 聚合为 SPU。</div></div>
    </div>
    <div class="card"><div class="row"><h3 style="margin:0">商品（${PRODUCTS.length}）</h3><span class="grow"></span>
      <input id="pq" placeholder="搜索标题 / SPU" style="width:220px">
      <input id="mSpu" placeholder="手动添加：SPU" style="width:140px"><input id="mTitle" placeholder="商品名" style="width:160px"><input id="mImg" placeholder="图片URL(可选)" style="width:150px">
      <button class="btn" id="mAdd">添加</button></div>
      <div class="pgrid" id="pgrid" style="margin-top:14px"></div></div>`;
  const draw = () => {
    const kw = $('#pq').value.trim().toLowerCase();
    const list = PRODUCTS.filter((p) => !kw || (p.title || '').toLowerCase().includes(kw) || (p.spu || '').toLowerCase().includes(kw));
    $('#pgrid').innerHTML = list.slice(0, 300).map((p) => `<div class="pcard" data-pid="${p.id}">
      ${p.image_url ? `<img loading="lazy" src="${esc(p.image_url)}">` : '<img>'}
      <div class="pb"><div class="pt">${esc(p.title)}</div>
      <input data-spu value="${esc(p.spu)}" title="SPU（写入命名）">
      <div class="row small" style="margin-top:6px"><span class="badge">${esc(p.source)}</span>${p.spu_manual ? '<span class="badge pri">SPU已手改</span>' : ''}<span class="grow"></span><button class="btn sm ghost danger" data-pdel>删除</button></div></div></div>`).join('')
      + (list.length > 300 ? `<div class="muted">仅显示前 300 个，请用搜索</div>` : '') + (list.length ? '' : '<div class="empty">暂无商品</div>');
  };
  draw();
  $('#pq').oninput = draw;
  const sync = async (btn, path, body) => {
    btn.disabled = true; const old = btn.textContent; btn.innerHTML = '<span class="spin"></span> 同步中';
    try { const r = await api('POST', path, body); toast(`同步完成：新增 ${r.added}，更新 ${r.updated}${r.warning ? '。' + r.warning : ''}`, r.warning ? '' : 'ok'); await loadProducts(); await loadState(); pageProducts(main); }
    catch (e) { fail(e); btn.disabled = false; btn.textContent = old; }
  };
  $('#syncShop').onclick = (e) => sync(e.target, '/api/products/sync/shopify', { domain: $('#shopDomain').value });
  $('#syncMeta').onclick = (e) => sync(e.target, '/api/products/sync/meta', { catalog_id: $('#catId').value });
  $('#mAdd').onclick = async () => {
    try { await api('POST', '/api/products', { spu: $('#mSpu').value.trim(), title: $('#mTitle').value.trim(), image_url: $('#mImg').value.trim() }); await loadProducts(); await loadState(); pageProducts(main); } catch (e) { fail(e); }
  };
  $('#pgrid').onchange = async (e) => {
    if (!e.target.hasAttribute('data-spu')) return;
    const pid = e.target.closest('[data-pid]').dataset.pid;
    try { await api('PUT', '/api/products/' + pid, { spu: e.target.value }); const p = PRODUCTS.find((x) => String(x.id) === pid); p.spu = e.target.value; p.spu_manual = 1; toast('SPU 已更新', 'ok'); } catch (er) { fail(er); }
  };
  $('#pgrid').onclick = async (e) => {
    if (!e.target.hasAttribute('data-pdel')) return;
    const pid = e.target.closest('[data-pid]').dataset.pid;
    await api('DELETE', '/api/products/' + pid).catch(fail);
    PRODUCTS = PRODUCTS.filter((x) => String(x.id) !== pid); draw(); loadState();
  };
}

/* ------------------------------------------------------------------ 页面：设置 */

function pageSettings(main) {
  const s = ST.settings;
  const dd = ST.fields.find((f) => f.key === 'designer' && f.type === 'enum');
  main.innerHTML = `<h1>设置</h1><p class="sub">密钥只保存在本机数据库（data/app.db）中。</p>
    <div class="card"><h3>AI 识别（OpenAI 兼容接口，需支持图片输入）</h3><div class="row">
      <label class="f grow">Base URL<input data-s="ai_base_url" value="${esc(s.ai_base_url)}"></label>
      <label class="f">模型<input data-s="ai_model" value="${esc(s.ai_model)}" style="width:200px"></label>
      <label class="f" title="视频口播转写（/audio/transcriptions），不支持的接口会自动跳过">语音转写模型<input data-s="ai_asr_model" value="${esc(s.ai_asr_model || 'whisper-1')}" style="width:130px"></label>
      <label class="f grow">API Key<input data-s="ai_api_key" type="password" placeholder="${s.ai_api_key_set ? '已配置（留空保持不变）' : 'sk-...'}"></label></div>
      <div class="small muted" style="margin-top:6px">可用 OpenAI（gpt-4o / gpt-4o-mini）、Gemini 的 OpenAI 兼容端点、通义千问 VL、豆包视觉等。</div></div>
    <div class="card"><h3>Meta（商品目录同步 / 广告数据拉取）</h3><div class="row">
      <label class="f grow">Access Token<input data-s="meta_token" type="password" placeholder="${s.meta_token_set ? '已配置（留空保持不变）' : 'EAAG...'}"></label>
      <label class="f">广告账户 ID<input data-s="meta_ad_account" value="${esc(s.meta_ad_account)}" placeholder="act_123..." style="width:180px"></label>
      <label class="f">Graph API 版本<input data-s="meta_api_version" value="${esc(s.meta_api_version)}" style="width:90px"></label></div></div>
    <div class="card"><h3>其他</h3><div class="row">
      <label class="f">默认设计师${dd ? `<select data-s="default_designer">${dd.values.map((v) => `<option value="${v.id}" ${String(v.id) === s.default_designer ? 'selected' : ''}>${esc(v.cn)} / ${esc(v.en)}</option>`).join('')}</select>` : '<span>（无设计师字段）</span>'}</label>
      <label class="f">货币<input data-s="currency" value="${esc(s.currency)}" style="width:80px"></label></div>
      <div class="small muted" style="margin-top:6px">设计师名单在「命名规范 → 设计师+日期」字段里维护。</div></div>
    <button class="btn pri" id="saveSet">保存设置</button>`;
  $('#saveSet').onclick = async () => {
    const body = {};
    $$('[data-s]', main).forEach((el) => { body[el.dataset.s] = el.value; });
    try { await loadState(await api('PUT', '/api/settings', body)); toast('已保存', 'ok'); pageSettings(main); } catch (e) { fail(e); }
  };
}

/* ------------------------------------------------------------------ 页面：数据分析 */

const AN = { from: '', to: '', dim: null, data: null, compact: true, q: { spu: '', lp: '' }, sort: { spu: 'revenue', lp: 'spend' }, focus: null, dx: {} };
const DX = {};

const fmtMoney = (x) => x == null ? '-' : (ST.settings.currency === 'CNY' ? '¥' : '$') + Number(x).toLocaleString(undefined, { maximumFractionDigits: x >= 100 ? 0 : 2 });
const fmtMoneyK = (x) => (x != null && x >= 10000 ? (ST.settings.currency === 'CNY' ? '¥' : '$') + (x / 1000).toFixed(1) + 'k' : fmtMoney(x));
const fmtOrders = (x) => x == null ? '-' : Math.round(x).toLocaleString();
const fmtNum = (x) => x == null ? '-' : Number(x).toLocaleString(undefined, { maximumFractionDigits: 1 });
const fmtPct = (x) => x == null ? '-' : (x * 100).toFixed(2) + '%';
const fmtShare = (x) => x == null ? '-' : (x * 100).toFixed(1) + '%';
const fmtRoas = (x) => x == null ? '-' : x.toFixed(2);

function roasCls(r, avg) { if (r == null || avg == null) return ''; return r >= avg * 1.1 ? 'roas-good' : r <= avg * 0.9 ? 'roas-bad' : ''; }

function bar(v, max, color, text) {
  const w = max ? Math.max(1, (v / max) * 100) : 0;
  return `<div class="bar"><div style="width:${w}%;background:${color}"></div><span>${text}</span></div>`;
}

const LP_TYPE = { home: ['官网首页', '#8a8fa3'], product: ['商品详情页', '#4f5bd5'], collection: ['类目/集合页', '#00a8c6'], page: ['活动页', '#d98a00'], other: ['其他', '#8a8fa3'] };
const SPU_ST = {
  breakout: ['爆款', '#e8590c', '近7日 GMV 快速增长且 ROAS 达标'],
  hot: ['热卖', '#c2255c', '贡献主要 GMV 的头部商品'],
  new: ['新品', '#4f5bd5', '首次投放 14 天内'],
  potential: ['潜力', '#12a36b', 'ROAS 高但投放量还小'],
  decline: ['衰退', '#d64545', 'GMV 或 ROAS 明显下滑'],
  steady: ['平稳', '#8a8fa3', '无明显变化'],
};
const stBadge = (s) => { const [n, c] = SPU_ST[s] || SPU_ST.steady; return `<span class="st-badge" style="color:${c};background:${c}14;border-color:${c}40">${n}</span>`; };
const STAGE_TIP = {
  hook_rate: '素材前 3 秒吸引力不足：优化开头钩子（痛点提问、效果对比等）。',
  ctr: '素材点击意愿低：检查卖点表达与行动号召是否清晰。',
  atc_rate: '点击后没有加购：落地页首屏与素材承诺可能不一致（价格/折扣/款式），或商品信息不够有说服力。',
  checkout_rate: '加购后未结账：检查运费、优惠码、尺码库存等购物车阶段阻力。',
  purchase_rate: '结账后未支付：检查支付方式、结账页加载速度与信任标识。',
};
const cmpPct = (v, b) => {
  if (v == null || !b) return '';
  const r = v / b - 1;
  return `<em class="cmp ${r >= 0.05 ? 'up' : r <= -0.05 ? 'down' : ''}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%</em>`;
};
const idxHtml = (x) => x == null ? '<span class="muted">-</span>' : `<span class="idx ${x >= 1.1 ? 'up' : x <= 0.9 ? 'down' : ''}">${x.toFixed(2)}</span>`;
const lpParts = (key) => { const i = key.indexOf('/'); return i < 0 ? { host: key, path: '/' } : { host: key.slice(0, i), path: key.slice(i) }; };
const lpBadge = (t) => { const [n, c] = LP_TYPE[t] || LP_TYPE.other; return `<span class="lp-type" style="color:${c};border-color:${c}33;background:${c}12">${n}</span>`; };
const goHref = (kind, id) => `#/analytics/${kind}/${encodeURIComponent(id)}`;

function sparkLine(rows, key, opts = {}) {
  const W = opts.w || 64, H = opts.h || 18, P = 2;
  const color = key === 'roas' ? '#12a36b' : '#4f5bd5';
  const vals = (rows || []).map((r) => r[key]);
  const ok = vals.filter((v) => v != null && isFinite(v));
  if (ok.length < 2) return `<svg class="sl" width="${W}" height="${H}"><line x1="${P}" y1="${H / 2}" x2="${W - P}" y2="${H / 2}" stroke="#e4e6ef" stroke-dasharray="2 3"/></svg>`;
  const mx = Math.max(...ok), mn = key === 'roas' ? Math.min(...ok) : 0, rg = mx - mn || 1;
  const n = vals.length;
  const x = (i) => (P + (i * (W - 2 * P)) / (n - 1)).toFixed(1);
  const y = (v) => (H - P - ((v - mn) / rg) * (H - 2 * P)).toFixed(1);
  let d = '', pen = false, last = -1;
  vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`; pen = true; last = i; });
  const area = key === 'spend' ? `<path d="${d}L${x(n - 1)},${H - P}L${x(0)},${H - P}Z" fill="${color}" opacity=".1"/>` : '';
  const tip = key === 'roas' ? `过去30日 ROAS ${fmtRoas(Math.min(...ok))} ~ ${fmtRoas(mx)}` : `过去30日消耗 ${fmtMoney(ok.reduce((a, b) => a + b, 0))}，单日峰值 ${fmtMoney(mx)}`;
  return `<svg class="sl" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>${tip}</title>${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>${last >= 0 ? `<circle cx="${x(last)}" cy="${y(vals[last])}" r="1.8" fill="${color}"/>` : ''}</svg>`;
}

function trendCell(rows, key2 = 'spend', label2 = '消耗') {
  return `<div class="tc"><span>ROAS</span>${sparkLine(rows, 'roas', { w: 76, h: 15 })}<span>${label2}</span>${sparkLine(rows, key2, { w: 76, h: 15 })}</div>`;
}

function mBlock(v, share, avg) {
  return `<div class="mb">
    <span class="mb-k">${v.assets ?? '-'} 素材</span><b class="mb-v ${roasCls(v.roas, avg)}">${fmtRoas(v.roas)}</b>${sparkLine(v.trend_30, 'roas')}
    <span class="mb-k" title="${fmtMoney(v.spend)}">${fmtMoneyK(v.spend)}</span><b class="mb-v mb-share">${fmtShare(share)}</b>${sparkLine(v.trend_30, 'spend')}
  </div>`;
}

function deltaHtml(x) {
  if (x == null) return '<span class="muted">-</span>';
  return `<span class="${x >= 0.05 ? 'roas-good' : x <= -0.05 ? 'roas-bad' : 'muted'}">${x >= 0 ? '▲' : '▼'} ${Math.abs(x).toFixed(2)}</span>`;
}

function trendSvg(rows, opts = {}) {
  if (rows.length < 2) return '';
  const key = opts.key || 'spend', kname = opts.name || '日消耗';
  rows = rows.map((r) => ({ ...r, spend: r[key] || 0 }));
  const W = 800, H = 130, P = 8, n = rows.length;
  const ms = Math.max(...rows.map((r) => r.spend)) || 1;
  const mr = Math.max(...rows.map((r) => r.roas || 0), 0.01) * 1.1;
  const x = (i) => P + (i * (W - 2 * P)) / (n - 1);
  const ys = (v) => H - P - (v / ms) * (H - 2 * P) * 0.9;
  const yr = (v) => H - P - (v / mr) * (H - 2 * P);
  const sp = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${ys(r.spend)}`).join('');
  let rp = '', pen = false;
  rows.forEach((r, i) => { if (r.roas == null) { pen = false; return; } rp += `${pen ? 'L' : 'M'}${x(i)},${yr(r.roas)}`; pen = true; });
  const cw = W / n;
  const hits = rows.map((r, i) => `<rect x="${x(i) - cw / 2}" y="0" width="${cw}" height="${H}" fill="transparent"><title>${r.date}  ${kname} ${fmtMoney(r.spend)}  ROAS ${fmtRoas(r.roas)}</title></rect>`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${sp}L${x(n - 1)},${H - P}L${x(0)},${H - P}Z" fill="#4f5bd5" opacity=".07"/>
      <path d="${sp}" fill="none" stroke="#4f5bd5" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
      <path d="${rp}" fill="none" stroke="#12a36b" stroke-width="2" vector-effect="non-scaling-stroke"/>${hits}</svg>
    <div class="legend"><span><i style="background:#4f5bd5"></i>${kname}</span><span><i style="background:#12a36b"></i>ROAS</span><span>${rows[0].date} ~ ${rows[n - 1].date}</span></div>`;
}

async function pageAnalytics(main) {
  const R = anRoute();
  const VIEWS = {
    tags: ['素材成效及标签分析', '按素材与命名标签拆解投放成效：哪些创意元素在起量、哪些在拖累，指导下一批素材怎么做。'],
    spu: ['商品（SPU）分析', '以商品为中心：识别热卖、爆款、衰退与新品，从素材中提炼爆品特征与每个商品的宣传方向。'],
    lp: ['落地页分析', '以落地页为中心：看转化漏斗在哪一步掉点，以及什么创意方向适合投到什么类型的页面。'],
  };
  main.innerHTML = `<h1>创意数据分析</h1>
    <p class="sub">投放数据回流后，按媒体素材 ID / Ad Name 短名称还原素材与标签，再从素材、商品、落地页三个视角交叉分析，各视角之间可互相跳转下钻。</p>
    <nav class="an-views">${Object.entries(VIEWS).map(([k, [t, d]]) => `<a href="#/analytics${k === 'tags' ? '' : '/' + k}" class="${R.view === k ? 'on' : ''}"><b>${t}</b><span>${d}</span></a>`).join('')}</nav>
    <div class="card"><div class="row">
      <label class="f">开始<input type="date" id="anFrom" value="${AN.from}"></label>
      <label class="f">结束<input type="date" id="anTo" value="${AN.to}"></label>
      <span class="grow"></span>
      <span class="ro-hide">
      <button class="btn" id="anCsv">导入 CSV（Meta/TikTok 报表）</button><input type="file" id="anFile" accept=".csv,text/csv" hidden>
      <button class="btn" id="anMeta">从 Meta 拉取</button>
      <button class="btn" id="anDemo">生成演示数据</button>
      <button class="btn danger" id="anClear">清空投放数据</button></span>
    </div></div>
    <div id="anBody"><div class="empty"><span class="spin"></span></div></div>
    ${R.view === 'tags' ? `<div class="card"><h3>Ad Name 解析器</h3><div class="row">
      <input id="decIn" class="grow mono" placeholder="粘贴任意 Ad Name，例如 US_Broad_VISMSTGY260101V1_1016">
      <button class="btn pri" id="decBtn">解析</button></div><div id="decOut" style="margin-top:10px"></div></div>` : ''}`;
  const reload = () => { AN.from = $('#anFrom').value; AN.to = $('#anTo').value; drawAnalytics(); };
  ['#anFrom', '#anTo'].forEach((s) => { $(s).onchange = reload; });
  $('#anCsv').onclick = () => $('#anFile').click();
  $('#anFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await api('POST', '/api/perf/import_csv', { text: await f.text(), source: 'csv:' + f.name }); toast(`导入 ${r.imported} 行；识别列：${Object.entries(r.columns).map(([k, v]) => k + '=' + v).join('，')}`, 'ok'); loadState(); drawAnalytics(); }
    catch (er) { fail(er); }
    e.target.value = '';
  };
  $('#anMeta').onclick = async (e) => {
    const until = AN.to || new Date().toISOString().slice(0, 10);
    const since = AN.from || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const b = e.target; b.disabled = true; b.innerHTML = '<span class="spin"></span> 拉取中';
    try { const r = await api('POST', '/api/perf/pull_meta', { since, until }); toast(`已拉取 ${r.imported} 行（${since} ~ ${until}）`, 'ok'); loadState(); drawAnalytics(); } catch (er) { fail(er); }
    b.disabled = false; b.textContent = '从 Meta 拉取';
  };
  $('#anDemo').onclick = async () => {
    if (!confirm('将生成 5 个演示商品、48 个演示素材和 30 天的模拟投放数据（含落地页与完整转化漏斗，可随时清除），继续？')) return;
    try { const r = await api('POST', '/api/demo/seed', {}); toast(`已生成：素材 ${r.assets}，数据 ${r.perf_rows} 行`, 'ok'); await loadProducts(); await loadState(); pageAnalytics(main); } catch (e) { fail(e); }
  };
  $('#anClear').onclick = async () => {
    const demo = confirm('「确定」= 只清除演示数据（演示商品/素材/投放数据）\n「取消」= 继续选择是否清空全部投放数据');
    try {
      if (demo) await api('DELETE', '/api/demo');
      else if (confirm('清空全部投放数据？（素材与命名不受影响）')) await api('DELETE', '/api/perf');
      else return;
      await loadProducts(); await loadState(); pageAnalytics(main);
    } catch (e) { fail(e); }
  };
  if (R.view === 'tags') {
    const decode = async () => {
      try {
        const r = await api('POST', '/api/decode', { ad_name: $('#decIn').value });
        $('#decOut').innerHTML = r.match === 'unmatched' ? '<span class="badge bad">未识别到短名称 / 完整命名 / 已绑定的素材</span>' :
          `<div class="row"><span class="badge pri">匹配方式：${MATCH_LABEL[r.match]}</span>${r.asset ? `<code class="mono">${esc(r.asset.short_name)}</code><span class="small mono muted">${esc(r.asset.full_name)}</span>` : `<code>${esc(r.short)}</code><span class="small muted">素材库中无此流水号，按短码字典解码</span>`}</div>
          <table class="t" style="margin-top:8px;max-width:700px"><tbody>${r.fields.map((f) => `<tr><td class="muted" style="width:120px">${esc(f.name)}</td><td>${f.value ? esc(f.value) : '<span class="muted">-</span>'}</td></tr>`).join('')}</tbody></table>`;
      } catch (e) { fail(e); }
    };
    $('#decBtn').onclick = decode;
    $('#decIn').onkeydown = (e) => { if (e.key === 'Enter') decode(); };
  }
  drawAnalytics();
}

function anRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  const view = ['spu', 'lp'].includes(p[1]) ? p[1] : 'tags';
  return { view, id: p[2] ? decodeURIComponent(p.slice(2).join('/')) : '' };
}

async function drawAnalytics() {
  const body = $('#anBody');
  const R = anRoute();
  const qs = `from=${AN.from}&to=${AN.to}`;
  const url = R.view === 'tags' ? `/api/analytics?${qs}`
    : R.id ? `/api/analytics/${R.view}/detail?${qs}&${R.view === 'spu' ? 'id' : 'lp'}=${encodeURIComponent(R.id)}`
      : `/api/analytics/${R.view}?${qs}`;
  let d;
  try { d = await api('GET', url); } catch (e) { fail(e); return; }
  AN.data = d;
  AN.view = R.view;
  if (!d.summary || !d.summary.spend) {
    body.innerHTML = R.id ? `<div class="card empty">该范围内暂无投放数据。<a href="#/analytics/${R.view}">返回列表</a></div>`
      : `<div class="card empty">${R.view === 'lp' ? '暂无带落地页信息的投放数据：CSV 需包含 Website URL / 落地页 列，Meta 拉取会自动读取广告链接。' : R.view === 'spu' ? '暂无可关联到商品的投放数据：请确认素材已选择 SPU，且广告能匹配到素材。' : '暂无投放数据。导入 CSV、从 Meta 拉取，或先生成演示数据体验。'}</div>`;
    return;
  }
  body.onclick = (e) => anClick(e, body);
  body.onchange = (e) => anChange(e);
  if (R.view === 'spu') return R.id ? drawSpuDetail(body, d) : drawSpuOverview(body, d);
  if (R.view === 'lp') return R.id ? drawLpDetail(body, d) : drawLpOverview(body, d);
  drawDeep(body, d);
}

function anClick(e, body) {
  if (e.target.closest('select, input, button.inline')) return;
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a')) { location.hash = go.dataset.go; return; }
  const dx = e.target.closest('[data-dx]');
  if (dx) {
    const [id, key] = dx.dataset.dx.split('|'); AN.dx[id] = key; DX[id] && DX[id]();
    if (dx.dataset.scroll) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const modeBtn = e.target.closest('[data-mode]');
  if (modeBtn) {
    AN.compact = modeBtn.dataset.mode === 'compact';
    $$('#dimMode .mode-btn', body).forEach((b) => b.classList.toggle('on', b.dataset.mode === (AN.compact ? 'compact' : 'detail')));
    drawDim();
    return;
  }
  const combo = e.target.closest('[data-combo]');
  if (combo) {
    const z = ((AN.data.advice || {}).combos || [])[+combo.dataset.combo];
    AN.focus = z ? { label: z.labels.join(' + '), names: z.short_names } : null;
    drawAssetRank();
    $('#assetRank').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (e.target.closest('[data-clear-focus]')) { AN.focus = null; drawAssetRank(); return; }
  const t = e.target.closest('[data-dim]');
  if (!t || !$('#dimTable')) return;
  AN.dim = t.dataset.dim;
  if (AN.compact) {
    AN.compact = false;
    $$('#dimMode .mode-btn', body).forEach((b) => b.classList.toggle('on', b.dataset.mode === 'detail'));
  }
  drawDim();
  $('#dimTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function kpiHtml(items) {
  return `<div class="kpis">${items.map(([k, v, cls]) => `<div class="kpi"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`).join('')}</div>`;
}

function insightHtml(d) {
  const insights = d.insights || [];
  const win = d.window || {};
  return insights.length
    ? `<ul class="insight-list">${insights.map((x) => `<li class="insight ${esc(x.type)}">
        <span class="insight-ico">${INSIGHT_ICON[x.type] || '•'}</span>
        <div><b>${esc(x.title)}</b><div class="small muted">${esc(x.detail)}</div></div>
      </li>`).join('')}</ul>
      <div class="small muted" style="margin-top:6px">对比窗口：近7日 ${esc((win.recent7 || []).join(' ~ '))} vs 前7日 ${esc((win.prior7 || []).join(' ~ '))}</div>`
    : '<div class="muted small" style="margin-top:10px">近 7 日相对前 7 日变化不明显，暂无突出结论。</div>';
}

const INSIGHT_ICON = { breakout: '🔥', decline: '↘', spu: '★', creative: '◎' };

function adviceHtml(d) {
  const a = d.advice || {};
  const lift = (x) => x == null ? '' : `<em class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%</em>`;
  const none = (t) => `<div class="adv-none">${t}</div>`;
  const chip = (k, v) => `<span class="chip"><i>${esc(k)}</i>${esc(v)}</span>`;
  const combos = (a.combos || []).map((z, i) => `<div class="adv-row" data-combo="${i}" title="点击在素材排行中只看这 ${z.assets} 个素材">
      <div class="adv-main">${chip(z.fields[0], z.labels[0])}<span class="plus">+</span>${chip(z.fields[1], z.labels[1])}</div>
      <div class="adv-meta">${z.assets} 素材 · ${fmtMoney(z.spend)}</div>
      <div class="adv-r roas-good">${fmtRoas(z.roas)}${lift(z.lift)}</div></div>`).join('') || none('暂无满足验证条件的组合');
  const item = (z, good) => `<div class="adv-row" data-dim="${esc(z.dim)}" title="查看该字段全部标签值">
      <div class="adv-main">${chip(z.dim_name, z.label)}</div>
      <div class="adv-meta">${z.assets} 素材 · 占比 ${fmtShare(z.share)}</div>
      <div class="adv-r ${good ? 'roas-good' : 'roas-bad'}">${fmtRoas(z.roas)}${lift(z.lift)}</div></div>`;
  return `<div class="card adv"><h3>素材生产建议 <span class="h-note">对照当前范围均值 ROAS ${fmtRoas(a.avg_roas)}</span></h3>
    <div class="adv-sec"><h4><b class="g">黄金组合</b><span>两字段交叉 · ≥2 个素材验证 · 消耗占比 ≥3%</span></h4>${combos}</div>
    <div class="adv-sec"><h4><b class="p">值得加产</b><span>ROAS 高于均值 15%+，但消耗占比 &lt;15%，样本还不够</span></h4>${(a.scale || []).map((z) => item(z, true)).join('') || none('暂无明显被低估的标签')}</div>
    <div class="adv-sec"><h4><b class="r">减少产出</b><span>消耗占比 ≥8%，但 ROAS 低于均值 15%+</span></h4>${(a.cut || []).map((z) => item(z, false)).join('') || none('暂无明显拖累的标签')}</div>
  </div>`;
}

let DIMS = [];

function drawDeep(body, d) {
  const s = d.summary;
  DIMS = d.dims.filter((x) => x.values.length);
  if (!AN.dim || !DIMS.some((x) => x.key === AN.dim)) AN.dim = (DIMS.find((x) => x.type === 'enum') || DIMS[0] || {}).key;
  AN.focus = null;
  const matched = s.spend - ((d.match.unmatched || {}).spend || 0);
  body.innerHTML = `${kpiHtml([['消耗', fmtMoney(s.spend)], ['ROAS', fmtRoas(s.roas)], ['CPA', fmtMoney(s.cpa)], ['CTR', fmtPct(s.ctr)], ['CVR', fmtPct(s.cvr)], ['标签还原率（按消耗）', fmtPct(s.spend ? matched / s.spend : null)]])}
    <div class="grid2">
      <div class="card"><h3>消耗与 ROAS 趋势</h3>${trendSvg(d.trend)}
        <h4 class="insight-h">近 7 日 ROAS 驱动结论</h4>${insightHtml(d)}</div>
      ${adviceHtml(d)}
    </div>
    <div class="card"><div class="row" style="margin-bottom:10px">
      <h3 style="margin:0">按标签字段汇总</h3>
      <span class="grow"></span>
      <div class="mode-toggle" id="dimMode">
        <button type="button" class="mode-btn ${AN.compact ? 'on' : ''}" data-mode="compact">简洁</button>
        <button type="button" class="mode-btn ${AN.compact ? '' : 'on'}" data-mode="detail">详细</button>
      </div></div>
      <div id="dimTable"></div></div>
    <div class="card" id="assetRank"></div>
    ${d.unmatched.length ? `<div class="card"><h3>未匹配的广告（${d.unmatched.length}）<span class="h-note">Ad Name 中没有短名称/完整命名，且媒体素材 ID 未绑定。可在素材编辑里补充媒体素材ID。</span></h3>
      <table class="t"><thead><tr><th>Ad Name</th><th class="num">消耗</th><th class="num">ROAS</th></tr></thead><tbody>
      ${d.unmatched.slice(0, 30).map((u) => `<tr><td class="mono small">${esc(u.ad_name)}</td><td class="num">${fmtMoney(u.spend)}</td><td class="num">${fmtRoas(u.roas)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  drawDim();
  drawAssetRank();
}

function drawDim() {
  const box = $('#dimTable');
  if (!box) return;
  const s = AN.data.summary;
  const dims = DIMS;
  const lab = (x, v) => x.type === 'lp' ? lpParts(v.label).path : v.label;
  if (AN.compact) {
    box.innerHTML = `<div class="dim-board">${dims.map((x) => {
      const tot = x.values.reduce((a, v) => a + v.spend, 0) || 1;
      return `<div class="dim-col ${x.key === AN.dim ? 'on' : ''}" data-dim="${esc(x.key)}">
        <div class="dim-col-h">${esc(x.name)}${x.type === 'ai' ? ' <span class="badge ai">AI</span>' : ''}</div>
        ${x.values.map((v) => `<div class="dim-val">
          <div class="dim-lab" title="${esc(v.label)}">${esc(lab(x, v))}</div>
          ${mBlock(v, v.spend / tot, s.roas)}
        </div>`).join('') || '<div class="muted small" style="padding:8px">无数据</div>'}
      </div>`;
    }).join('')}</div>
    <div class="dim-legend small muted"><span>第一行：素材数 · ROAS · <i class="lg g"></i>ROAS 趋势</span><span>第二行：消耗 · 占比 · <i class="lg b"></i>消耗趋势</span><span>趋势均为过去 30 日 · 点击字段查看详细</span></div>`;
    return;
  }
  const x = dims.find((y) => y.key === AN.dim);
  if (!x) { box.innerHTML = ''; return; }
  const tot = x.values.reduce((a, v) => a + v.spend, 0) || 1;
  const maxR = Math.max(...x.values.map((v) => v.roas || 0)) || 1;
  const cell = (v) => {
    if (x.type === 'lp') return `<a href="${goHref('lp', v.label)}">${esc(lpParts(v.label).path)}</a>`;
    if (x.type === 'product') {
      const p = (AN.data.products || []).find((q) => q.spu === v.label);
      return p ? `<a href="${goHref('spu', p.product_id)}">${esc(v.label)}</a>` : esc(v.label);
    }
    return esc(v.label);
  };
  box.innerHTML = `<div class="tabs">${dims.map((t) => `<span class="tab ${t.type === 'ai' ? 'ai' : ''} ${t.key === AN.dim ? 'on' : ''}" data-dim="${esc(t.key)}">${esc(t.name)}</span>`).join('')}</div>
    <table class="t"><thead><tr><th>${esc(x.name)}</th><th class="num">素材数</th><th style="width:16%">消耗占比</th><th class="num">消耗</th>
      <th>30日趋势</th><th class="num">CTR</th><th class="num">CPC</th><th class="num">CVR</th><th class="num">CPA</th>
      <th style="width:14%">ROAS（均值 ${fmtRoas(s.roas)}）</th></tr></thead><tbody>
    ${x.values.map((v) => `<tr><td>${cell(v)}</td><td class="num">${v.assets}</td><td>${bar(v.spend, tot, '#cfd4fa', fmtShare(v.spend / tot))}</td>
      <td class="num">${fmtMoney(v.spend)}</td><td>${trendCell(v.trend_30)}</td>
      <td class="num">${fmtPct(v.ctr)}</td><td class="num">${fmtMoney(v.cpc)}</td><td class="num">${fmtPct(v.cvr)}</td><td class="num">${fmtMoney(v.cpa)}</td>
      <td>${bar(v.roas || 0, maxR, (v.roas || 0) >= (s.roas || 0) ? '#bfe9d6' : '#f6d0d0', `<span class="${roasCls(v.roas, s.roas)}">${fmtRoas(v.roas)}</span>`)}</td></tr>`).join('')}
    </tbody></table>${x.type === 'ai' ? '<div class="small muted" style="margin-top:6px">AI 标签：一个素材可以有多个同类标签，因此各值消耗之和可能大于总消耗。</div>' : ''}`;
}

function drawAssetRank() {
  const box = $('#assetRank');
  if (!box) return;
  const d = AN.data, s = d.summary;
  const prodMap = Object.fromEntries((d.products || []).map((p) => [p.product_id, p]));
  const lpMap = Object.fromEntries((d.lps || []).map((p) => [p.lp, p]));
  let list = d.assets;
  if (AN.focus) list = list.filter((a) => AN.focus.names.includes(a.short_name));
  box.innerHTML = `<div class="row" style="margin-bottom:8px"><h3 style="margin:0">素材排行（${list.length}）</h3>
      ${AN.focus ? `<span class="focus-chip">仅看组合：${esc(AN.focus.label)} <button data-clear-focus title="清除">×</button></span>` : ''}</div>
    <div style="overflow:auto"><table class="t"><thead><tr>
      <th></th><th>短名称 / 标签</th><th>SPU / 落地页</th><th>30日趋势</th><th class="num">消耗</th><th class="num">CTR</th><th class="num">CVR</th><th class="num">CPA</th><th class="num">ROAS</th><th>匹配</th>
    </tr></thead><tbody>
      ${list.slice(0, 100).map((a) => {
        const p = prodMap[a.product_id];
        return `<tr><td>${a.thumb ? `<img class="th" src="${a.thumb}">` : '<div class="th"></div>'}</td>
        <td><code class="mono" style="color:var(--pri);font-weight:600">${esc(a.short_name)}</code><div class="small mono muted" style="word-break:break-all">${esc(a.full_name)}</div>
          <div class="tagline" style="margin-top:3px">${d.fields.filter((f) => f.type !== 'ai_tags' && f.type !== 'product').map((f) => { const v = a.values[f.key]; const l = v && (v.cn || v.text || (v.n ? 'V' + v.n : '') || v.date); return l ? `<span class="badge" title="${esc(f.name)}">${esc(l)}</span>` : ''; }).join('')}
          ${a.ai_tags.map((t) => `<span class="badge ai">${esc(t.cn)}</span>`).join('')}</div></td>
        <td class="xlinks">${p ? `<a class="chip-link" href="${goHref('spu', p.product_id)}">${esc(p.spu)}</a>` : '<span class="muted small">未关联 SPU</span>'}
          ${(a.lps || []).slice(0, 3).map((k) => `<a class="lp-link" href="${goHref('lp', k)}" title="${esc(k)}">${lpBadge((lpMap[k] || {}).lp_type)}${esc(lpParts(k).path)}</a>`).join('')}${(a.lps || []).length > 3 ? `<span class="small muted">+${a.lps.length - 3}</span>` : ''}</td>
        <td>${trendCell(a.trend_30)}</td>
        <td class="num">${fmtMoney(a.spend)}</td><td class="num">${fmtPct(a.ctr)}</td><td class="num">${fmtPct(a.cvr)}</td><td class="num">${fmtMoney(a.cpa)}</td>
        <td class="num ${roasCls(a.roas, s.roas)}">${fmtRoas(a.roas)}</td><td>${a.match.map((m) => `<span class="badge" style="color:${MATCH_COLOR[m]}">${MATCH_LABEL[m]}</span>`).join(' ')}</td></tr>`;
      }).join('')}
    </tbody></table></div>`;
}

/* ---------- 视角共用组件：漏斗 / 掉点诊断 / 标签拆解 / 列表 ---------- */

const fmtCount = (x) => x == null ? '-' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e4 ? (x / 1e3).toFixed(1) + 'k' : Number(x).toLocaleString(undefined, { maximumFractionDigits: 0 });
const chipHtml = (k, v) => `<span class="chip"><i>${esc(k)}</i>${esc(v)}</span>`;
const growthHtml = (g) => g == null ? '<span class="muted">-</span>' : `<span class="${g >= 0.1 ? 'roas-good' : g <= -0.1 ? 'roas-bad' : 'muted'}">${g >= 0 ? '+' : ''}${(g * 100).toFixed(0)}%</span>`;
const lpTypeSelect = (lp, t) => `<select class="lp-sel" data-lp-type="${esc(lp)}" title="修正页面类型">${Object.entries(LP_TYPE).map(([k, [n]]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${n}</option>`).join('')}</select>`;

async function anChange(e) {
  const sel = e.target.closest('[data-lp-type]');
  const nm = e.target.closest('[data-lp-name]');
  if (!sel && !nm) return;
  const lp = sel ? sel.dataset.lpType : nm.dataset.lpName;
  const d = AN.data;
  const cur = (d.lps || []).find((x) => x.lp === lp) || (d.lp === lp ? d : {});
  try {
    await api('PUT', '/api/lp_meta', { lp, type: sel ? sel.value : (cur.lp_type || ''), name: nm ? nm.value : (cur.name || '') });
    toast(sel ? '已修正页面类型，重新计算中' : '已保存页面名称', 'ok');
    if (sel) drawAnalytics();
  } catch (er) { fail(er); }
}

function funnelHtml(m, cmp, cmpName) {
  const has = (m.atc || 0) > 0;
  const steps = [['impressions', '曝光', null], ['clicks', '点击', 'ctr'], ['atc', '加购', 'atc_rate'], ['checkout', '结账', 'checkout_rate'], ['conversions', '购买', 'purchase_rate']]
    .filter(([k]) => has || !['atc', 'checkout'].includes(k));
  const top = Math.log10((m.impressions || 0) + 10);
  const rows = steps.map(([k, n, rk], i) => {
    const v = m[k] || 0;
    const w = Math.max(16, (Math.log10(v + 10) / top) * 100);
    return `<div class="fn-row"><span class="fn-n">${n}</span>
      <div class="fn-bar"><div style="width:${w}%;background:rgba(79,91,213,${0.95 - i * 0.09})"><b>${fmtCount(v)}</b></div></div>
      <span class="fn-r">${rk ? `<b>${fmtPct(m[rk])}</b>${cmp ? cmpPct(m[rk], cmp[rk]) : ''}` : '<span class="muted small">转化率</span>'}</span></div>`;
  }).join('');
  const video = m.v3s ? `<div class="fn-video"><span class="fn-vt">视频</span>3秒完播率 <b>${fmtPct(m.hook_rate)}</b>${cmp ? cmpPct(m.hook_rate, cmp.hook_rate) : ''}
      <span class="sep">·</span>ThruPlay / 3秒播放 <b>${fmtPct(m.hold_rate)}</b>${cmp ? cmpPct(m.hold_rate, cmp.hold_rate) : ''}</div>` : '';
  return `<div class="funnel">${rows}</div>
    <div class="fn-foot"><span>点击→购买 CVR <b>${fmtPct(m.cvr)}</b>${cmp ? cmpPct(m.cvr, cmp.cvr) : ''}</span><span>客单价 <b>${fmtMoney(m.aov)}</b>${cmp ? cmpPct(m.aov, cmp.aov) : ''}</span>
      ${cmpName ? `<span class="muted">百分比 = 相对${esc(cmpName)}</span>` : ''}</div>${video}
    ${has ? '' : '<div class="note" style="margin:8px 0 0">缺少加购 / 结账数据：CSV 需包含「加入购物车」「发起结账」列，Meta 拉取会自动读取。</div>'}`;
}

function diagHtml(diag) {
  if (!diag || !diag.stages.length) return '<div class="muted small">数据不足，暂无法诊断。</div>';
  const w = diag.worst;
  const rows = diag.stages.map((s) => {
    const r = s.ratio;
    const bw = (Math.min(Math.abs(r - 1), 0.6) / 0.6) * 50;
    return `<div class="dg-row ${w && w.key === s.key ? 'worst' : ''}">
      <span class="dg-n">${s.name}<small>${s.step}</small></span><b class="dg-v">${fmtPct(s.value)}</b>
      <div class="dg-bar"><i></i><div class="${r >= 1 ? 'up' : 'down'}" style="${r >= 1 ? 'left' : 'right'}:50%;width:${bw}%"></div></div>
      <span class="dg-b">${fmtPct(s.base)}</span><span class="dg-r ${r >= 1.05 ? 'up' : r <= 0.95 ? 'down' : ''}">${(r * 100).toFixed(0)}%</span></div>`;
  }).join('');
  const concl = w
    ? `<div class="dg-c bad"><b>主要掉点：${w.step}</b>（${w.name}仅为${esc(diag.base_name)}的 ${(w.ratio * 100).toFixed(0)}%）<div>${STAGE_TIP[w.key] || ''}</div></div>`
    : `<div class="dg-c ok">各环节转化率均不低于${esc(diag.base_name)}的 92%，漏斗健康。</div>`;
  return `<div class="dg-row dg-head"><span>环节</span><span class="dg-v">本对象</span><span class="dg-bar-h">相对表现</span><span class="dg-b">${esc(diag.base_name)}</span><span class="dg-r">比值</span></div>${rows}${concl}`;
}

function dxBlock(id, dims, base, prefer) {
  const render = () => {
    if (!dims.length) return '<div class="muted small">暂无标签数据</div>';
    let key = AN.dx[id];
    if (!dims.some((x) => x.key === key)) key = AN.dx[id] = (dims.find((x) => prefer && x.name.includes(prefer)) || dims.find((x) => x.type === 'enum') || dims[0]).key;
    const d = dims.find((x) => x.key === key);
    const maxR = Math.max(...d.values.map((v) => v.roas || 0), 0.01);
    return `<div class="tabs">${dims.map((t) => `<span class="tab ${t.type === 'ai' ? 'ai' : ''} ${t.key === key ? 'on' : ''}" data-dx="${id}|${esc(t.key)}">${esc(t.name)}</span>`).join('')}</div>
      <table class="t"><thead><tr><th>${esc(d.name)}</th><th class="num">素材</th><th class="num">消耗占比</th><th class="num">3秒完播</th><th class="num">CTR</th><th class="num">加购率</th><th class="num">CVR</th>
        <th style="width:15%">ROAS（整体 ${fmtRoas(base.roas)}）</th><th class="num" title="标签 ROAS ÷ 整体 ROAS">指数</th><th>30日趋势</th></tr></thead><tbody>
      ${d.values.map((v) => `<tr><td class="lab-cell" title="${esc(v.label)}">${esc(v.label)}</td><td class="num">${v.assets}</td><td class="num">${fmtShare(v.share)}</td><td class="num">${fmtPct(v.hook_rate)}</td>
        <td class="num">${fmtPct(v.ctr)}</td><td class="num">${fmtPct(v.atc_rate)}</td><td class="num">${fmtPct(v.cvr)}</td>
        <td>${bar(v.roas || 0, maxR, (v.roas || 0) >= (base.roas || 0) ? '#bfe9d6' : '#f6d0d0', `<span class="${roasCls(v.roas, base.roas)}">${fmtRoas(v.roas)}</span>`)}</td>
        <td class="num">${idxHtml(v.index)}</td><td>${trendCell(v.trend_30)}</td></tr>`).join('')}
      </tbody></table>${d.type === 'ai' ? '<div class="small muted" style="margin-top:6px">AI 标签：一个素材可有多个同类标签，占比之和可能大于 100%。</div>' : ''}`;
  };
  DX[id] = () => { const el = document.getElementById(id); if (el) el.innerHTML = render(); };
  return `<div id="${id}">${render()}</div>`;
}

function assetTable(list, base, opts = {}) {
  if (!list.length) return '<div class="muted small">暂无素材</div>';
  return `<div style="overflow:auto"><table class="t"><thead><tr><th></th><th>短名称 / 创意标签</th>${opts.lps ? '<th>落地页</th>' : ''}<th>30日趋势</th>
      <th class="num">消耗</th><th class="num">3秒完播</th><th class="num">CTR</th><th class="num">加购率</th><th class="num">CVR</th><th class="num">ROAS</th><th class="num">近7日 ΔROAS</th></tr></thead><tbody>
    ${list.slice(0, opts.limit || 60).map((a) => `<tr>
      <td>${a.thumb ? `<img class="th" src="${a.thumb}">` : '<div class="th"></div>'}</td>
      <td><code class="mono" style="color:var(--pri);font-weight:600">${esc(a.short_name)}</code>
        <div class="tagline" style="margin-top:3px">${(a.labels || []).map((l) => `<span class="badge ${l.ai ? 'ai' : ''}" title="${esc(l.dim)}：${esc(l.label)}">${esc(l.label)}</span>`).join('')}</div></td>
      ${opts.lps ? `<td class="xlinks">${(a.lps || []).slice(0, 3).map((k) => `<a class="lp-link" href="${goHref('lp', k)}" title="${esc(k)}">${esc(lpParts(k).path)}</a>`).join('')}</td>` : ''}
      <td>${trendCell(a.trend_30)}</td><td class="num">${fmtMoney(a.spend)}</td><td class="num">${fmtPct(a.hook_rate)}</td><td class="num">${fmtPct(a.ctr)}</td>
      <td class="num">${fmtPct(a.atc_rate)}</td><td class="num">${fmtPct(a.cvr)}</td><td class="num ${roasCls(a.roas, base.roas)}"><b>${fmtRoas(a.roas)}</b></td><td class="num">${deltaHtml(a.delta_roas)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function lpTable(list, base, opts = {}) {
  if (!list.length) return '<div class="muted small">暂无落地页数据</div>';
  const tot = base.spend || 1;
  const topCell = (v) => `<td><div class="ta-cell">${(v.top_assets || []).map((a) => `<div class="ta" title="${esc(a.short_name)}&#10;近30日消耗 ${fmtMoney(a.spend)} · ROAS ${fmtRoas(a.roas)}">
      ${a.thumb ? `<img src="${esc(a.thumb)}">` : '<div class="ta-ph"></div>'}<div class="ta-m"><b>${a.spend >= 1000 ? fmtMoneyK(10000).slice(0, 1) + (a.spend / 1000).toFixed(1) + 'k' : fmtMoney(Math.round(a.spend))}</b><span class="${roasCls(a.roas, base.roas)}">${fmtRoas(a.roas)}</span></div></div>`).join('') || '<span class="muted small">-</span>'}</div></td>`;
  return `<div style="overflow:auto"><table class="t ent lp-t"><thead><tr><th>类型</th><th>落地页</th><th class="num">素材</th>${opts.top ? '<th>近30日消耗 Top3 素材<div class="muted" style="font-weight:400">消耗 · ROAS</div></th>' : ''}<th>消耗 · 占比</th><th class="num">ROAS</th>
      <th class="num">CTR</th><th class="num">加购率</th><th class="num">结账率</th><th class="num">支付率</th><th class="num">CVR</th><th class="num">3秒完播</th>
      ${opts.compact ? '' : '<th>30日趋势 · 近7日 ΔROAS</th>'}${opts.drop ? '<th>漏斗掉点</th>' : ''}<th></th></tr></thead><tbody>
    ${list.map((v) => { const p = lpParts(v.lp); return `<tr class="clickable" data-go="${goHref('lp', v.lp)}">
      <td>${opts.editable ? lpTypeSelect(v.lp, v.lp_type) : lpBadge(v.lp_type)}</td>
      <td><b class="mono">${esc(p.path)}</b><div class="small muted">${v.name ? `<b>${esc(v.name)}</b> · ` : ''}<span class="mono">${esc(p.host)}</span>${v.lp_product ? ` · <a href="${goHref('spu', v.lp_product.product_id)}">${esc(v.lp_product.spu)}</a>` : ''}</div></td>
      <td class="num">${v.assets}</td>${opts.top ? topCell(v) : ''}<td style="min-width:110px">${bar(v.spend, tot, '#cfd4fa', `${fmtMoney(v.spend)} · ${fmtShare(v.spend / tot)}`)}</td>
      <td class="num ${roasCls(v.roas, base.roas)}"><b>${fmtRoas(v.roas)}</b></td><td class="num">${fmtPct(v.ctr)}</td><td class="num">${fmtPct(v.atc_rate)}</td>
      <td class="num">${fmtPct(v.checkout_rate)}</td><td class="num">${fmtPct(v.purchase_rate)}</td><td class="num">${fmtPct(v.cvr)}</td><td class="num">${fmtPct(v.hook_rate)}</td>
      ${opts.compact ? '' : `<td><div class="tr-d">${trendCell(v.trend_30)}<span>${deltaHtml(v.delta_roas)}</span></div></td>`}
      ${opts.drop ? `<td>${v.drop ? `<span class="drop" title="${esc(STAGE_TIP[v.drop.key] || '')}">${v.drop.name} ${(v.drop.ratio * 100).toFixed(0)}%</span>` : '<span class="ok-tag">健康</span>'}</td>` : ''}
      <td class="go">›</td></tr>`; }).join('')}
    </tbody></table></div>`;
}

function spuMiniTable(list, base) {
  if (!list.length) return '<div class="muted small">暂无商品数据</div>';
  const tot = base.spend || 1;
  return `<table class="t ent"><thead><tr><th></th><th>SPU</th><th>消耗 · 占比</th><th class="num">ROAS</th><th class="num">加购率</th><th class="num">CVR</th><th class="num">客单价</th><th></th></tr></thead><tbody>
    ${list.map((v) => `<tr class="clickable" data-go="${goHref('spu', v.product_id)}">
      <td>${v.image ? `<img class="th sm" src="${esc(v.image)}">` : '<div class="th sm"></div>'}</td>
      <td><b class="mono">${esc(v.spu)}</b><div class="small muted ellip">${esc(v.title)}</div></td>
      <td style="min-width:130px">${bar(v.spend, tot, '#cfd4fa', `${fmtMoney(v.spend)} · ${fmtShare(v.spend / tot)}`)}</td>
      <td class="num ${roasCls(v.roas, base.roas)}"><b>${fmtRoas(v.roas)}</b></td><td class="num">${fmtPct(v.atc_rate)}</td><td class="num">${fmtPct(v.cvr)}</td>
      <td class="num">${fmtMoney(v.aov)}</td><td class="go">›</td></tr>`).join('')}</tbody></table>`;
}

function bindList(kind, all, render, text, sorts) {
  const draw = () => {
    const q = AN.q[kind].trim().toLowerCase();
    let list = all.filter((v) => !q || text(v).toLowerCase().includes(q));
    if (AN.stf && kind === 'spu' && AN.stf !== 'all') list = list.filter((v) => v.status === AN.stf);
    const kf = sorts[AN.sort[kind]] || Object.values(sorts)[0];
    list = [...list].sort((a, b) => kf(b) - kf(a));
    $('#entTable').innerHTML = render(list);
  };
  if (!sorts[AN.sort[kind]]) AN.sort[kind] = Object.keys(sorts)[0];
  $('#entSort').value = AN.sort[kind];
  $('#entSort').onchange = (e) => { AN.sort[kind] = e.target.value; draw(); };
  $('#entQ').oninput = (e) => { AN.q[kind] = e.target.value; draw(); };
  const stf = $('#entStatus');
  if (stf) { stf.value = AN.stf || 'all'; stf.onchange = (e) => { AN.stf = e.target.value; draw(); }; }
  draw();
}

/* ---------- 落地页分析 ---------- */

function fitMatrix(d) {
  const id = 'lpfit';
  const types = d.types.map((t) => t.type);
  const render = () => {
    const dims = d.fit;
    if (!dims.length) return '<div class="muted small">暂无创意标签数据</div>';
    let key = AN.dx[id];
    if (!dims.some((x) => x.key === key)) key = AN.dx[id] = (dims.find((x) => x.name.includes('创意方向')) || dims.find((x) => x.type === 'enum') || dims[0]).key;
    const dm = dims.find((x) => x.key === key);
    const heat = (c) => {
      if (!c) return '<td class="hm na">-</td>';
      if (!c.ok || c.index == null) return `<td class="hm na" title="样本不足：${c.assets} 个素材，消耗 ${fmtMoney(c.spend)}">${fmtRoas(c.roas)}</td>`;
      const v = Math.max(-1, Math.min(1, (c.index - 1) / 0.45));
      const bg = v >= 0 ? `rgba(18,163,107,${0.06 + v * 0.4})` : `rgba(214,69,69,${0.06 - v * 0.34})`;
      return `<td class="hm" style="background:${bg}" title="ROAS ${fmtRoas(c.roas)} · CVR ${fmtPct(c.cvr)} · 加购率 ${fmtPct(c.atc_rate)} · ${c.assets} 素材 · ${fmtMoney(c.spend)}"><b>${fmtRoas(c.roas)}</b><small>×${c.index.toFixed(2)}</small></td>`;
    };
    return `<div class="tabs">${dims.map((t) => `<span class="tab ${t.type === 'ai' ? 'ai' : ''} ${t.key === key ? 'on' : ''}" data-dx="${id}|${esc(t.key)}">${esc(t.name)}</span>`).join('')}</div>
      <table class="t hm-t"><thead><tr><th>${esc(dm.name)}</th>${types.map((t) => `<th class="num">${lpBadge(t)}</th>`).join('')}<th class="num">合计 ROAS</th></tr></thead><tbody>
      ${dm.values.map((v) => `<tr><td class="lab-cell" title="${esc(v.label)}">${esc(v.label)}<div class="small muted">${v.assets} 素材 · ${fmtMoney(v.spend)}</div></td>${types.map((t) => heat(v.cells[t])).join('')}<td class="num">${fmtRoas(v.roas)}</td></tr>`).join('')}
      <tr class="hm-base"><td>页面类型整体 ROAS</td>${d.types.map((t) => `<td class="num">${fmtRoas(t.roas)}</td>`).join('')}<td class="num">${fmtRoas(d.summary.roas)}</td></tr></tbody></table>`;
  };
  DX[id] = () => { const el = document.getElementById(id); if (el) el.innerHTML = render(); };
  return `<div id="${id}">${render()}</div>`;
}

function drawLpOverview(body, d) {
  const s = d.summary;
  const gap = d.all_spend - s.spend;
  const note = gap > d.all_spend * 0.005 ? `<div class="note">${fmtMoney(gap)}（${fmtShare(gap / d.all_spend)}）消耗缺少落地页信息，未计入本视角。</div>` : '';
  const T = d.types;
  const best = (key) => Math.max(...T.map((t) => t[key] || 0));
  const cell = (t, key) => `<td class="num ${t[key] && t[key] === best(key) && T.length > 1 ? 'best' : ''}">${fmtPct(t[key])}</td>`;
  const typeTable = `<table class="t"><thead><tr><th>页面类型</th><th class="num">页面</th><th style="width:20%">消耗占比</th><th class="num">CTR</th><th class="num">加购率</th><th class="num">结账率</th>
      <th class="num">支付率</th><th class="num">CVR</th><th class="num">客单价</th><th class="num">ROAS</th></tr></thead><tbody>
    ${T.map((t) => `<tr><td>${lpBadge(t.type)}</td><td class="num">${t.pages}</td><td>${bar(t.spend, s.spend, '#cfd4fa', fmtShare(t.spend / s.spend))}</td>
      ${cell(t, 'ctr')}${cell(t, 'atc_rate')}${cell(t, 'checkout_rate')}${cell(t, 'purchase_rate')}${cell(t, 'cvr')}
      <td class="num">${fmtMoney(t.aov)}</td><td class="num ${roasCls(t.roas, s.roas)}"><b>${fmtRoas(t.roas)}</b></td></tr>`).join('')}</tbody></table>`;
  const rcRow = (x, good) => `<div class="rc-row" data-dx="lpfit|${esc(x.dim)}" data-scroll="1"
      title="${esc(x.dim_name)}：${esc(x.label)}&#10;此类页面 ROAS ${fmtRoas(x.roas)}，该标签全站 ROAS ${fmtRoas(x.label_roas)}&#10;${x.assets} 个素材 · 消耗 ${fmtMoney(x.spend)}&#10;点击在下方矩阵查看">
      <div class="rc-l"><i>${esc(x.dim_name)}</i><b>${esc(x.label)}</b></div>
      <div class="rc-x ${good ? 'up' : 'down'}">×${x.index.toFixed(2)}</div>
      <div class="rc-m"><div>ROAS <b>${fmtRoas(x.roas)}</b></div>${good
        ? `<span>全站 ${fmtRoas(x.label_roas)}</span>`
        : x.alt_type ? `<span>改投${esc(LP_TYPE[x.alt_type][0])} ${fmtRoas(x.alt_roas)}</span>` : `<span>全站 ${fmtRoas(x.label_roas)}</span>`}</div></div>`;
  const recipes = T.map((t) => {
    const good = d.best_for[t.type] || [], bad = (d.avoid_for || {})[t.type] || [];
    return `<div class="rc">
      <div class="rc-h">${lpBadge(t.type)}<span class="small muted">${t.pages} 个页面 · 消耗占比 ${fmtShare(t.spend / (s.spend || 1))} · ROAS <b class="${roasCls(t.roas, s.roas)}">${fmtRoas(t.roas)}</b></span></div>
      <div class="rc-sec up">✓ 优先投</div>${good.map((x) => rcRow(x, true)).join('') || '<div class="rc-none">暂无显著更适合的标签</div>'}
      <div class="rc-sec down">✕ 避免投</div>${bad.map((x) => rcRow(x, false)).join('') || '<div class="rc-none">暂无明显不适合的标签</div>'}
    </div>`;
  }).join('');
  body.innerHTML = `${kpiHtml([['落地页数', d.lps.length], ['消耗', fmtMoney(s.spend)], ['ROAS', fmtRoas(s.roas)], ['加购率', fmtPct(s.atc_rate)], ['点击→购买 CVR', fmtPct(s.cvr)], ['3秒完播率', fmtPct(s.hook_rate)]])}${note}
    <div class="grid2">
      <div class="card"><h3>整体转化漏斗 <span class="h-note">全部落地页合计</span></h3>${funnelHtml(s)}</div>
      <div class="card"><h3>落地页类型对比 <span class="h-note">绿色 = 该环节最佳的页面类型</span></h3>${typeTable}</div>
    </div>
    <div class="card"><h3>创意 × 落地页投放配方 <span class="h-note">按页面类型给出该投 / 不该投的创意标签。×适配指数 = 实际 ROAS ÷ 预期 ROAS（页面类型均值 × 标签全站强弱），只看搭配效果；要求 ≥3 素材且消耗占比 ≥2%</span></h3>
      <div class="rc-grid">${recipes}</div>
      <h4 class="sub-h" style="margin-top:18px">适配矩阵 <span class="small muted" style="font-weight:400">切换标签字段查看每个标签在各类页面的 ROAS 与 ×适配指数；样本不足（&lt;2 个素材或消耗过低）置灰</span></h4>
      <div class="fit-matrix">${fitMatrix(d)}</div></div>
    <div class="card"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">落地页列表</h3><span class="h-note">类型可手动修正；点击行查看漏斗诊断、适配素材与承接商品</span>
      <span class="grow"></span><input id="entQ" placeholder="搜索路径 / 名称" value="${esc(AN.q.lp)}" style="width:200px">
      <select id="entSort"><option value="spend">按消耗</option><option value="roas">按 ROAS</option><option value="cvr">按 CVR</option><option value="atc_rate">按加购率</option><option value="delta">按近7日变化</option></select></div>
      <div id="entTable"></div></div>`;
  bindList('lp', d.lps, (list) => lpTable(list, s, { editable: true, drop: true, top: true }), (v) => `${v.lp} ${v.name || ''}`,
    { spend: (v) => v.spend, roas: (v) => v.roas ?? -1, cvr: (v) => v.cvr ?? -1, atc_rate: (v) => v.atc_rate ?? -1, delta: (v) => v.delta_roas ?? -99 });
}

function drawLpDetail(body, d) {
  const m = d.summary, p = lpParts(d.lp);
  const fitRow = (x) => `<div class="adv-row" data-dx="lpdims|${esc(x.dim)}"><div class="adv-main">${chipHtml(x.dim_name, x.label)}</div>
      <div class="adv-meta">${x.assets} 素材 · 占比 ${fmtShare(x.share)} · 加购率 ${fmtPct(x.atc_rate)} · 该标签全站 ROAS ${fmtRoas(x.site_roas)}</div>
      <div class="adv-r ${x.index >= 1 ? 'roas-good' : 'roas-bad'}">${fmtRoas(x.roas)}<em class="${x.index >= 1 ? 'up' : 'down'}">×${x.index.toFixed(2)}</em></div></div>`;
  const diagId = AN.dx.lpdiag === 'site' ? 'site' : 'type';
  body.innerHTML = `<div class="drill-head"><a class="back" href="#/analytics/lp">← 全部落地页</a>${lpTypeSelect(d.lp, d.lp_type)}
      <div class="dh-main"><div class="dh-t mono">${esc(p.path)}</div><div class="small muted mono">${esc(p.host)}</div></div>
      <input class="lp-name" data-lp-name="${esc(d.lp)}" value="${esc(d.name)}" placeholder="给页面起个名字，如：夏季大促页">
      <span class="grow"></span>${d.lp_product ? `<a class="chip-link" href="${goHref('spu', d.lp_product.product_id)}">对应商品 ${esc(d.lp_product.spu)} →</a>` : ''}
      <a class="small" href="https://${esc(d.lp)}" target="_blank" rel="noopener">打开页面 ↗</a></div>
    ${kpiHtml([['消耗', fmtMoney(m.spend)], ['GMV', fmtMoney(m.revenue)], ['ROAS', fmtRoas(m.roas), roasCls(m.roas, d.same_type.roas)], ['加购率', fmtPct(m.atc_rate)], ['点击→购买 CVR', fmtPct(m.cvr)], ['投放素材', m.assets]])}
    <div class="grid2">
      <div class="card"><h3>转化漏斗 <span class="h-note">百分比对比同类页面（${esc(d.type_name)}）均值</span></h3>${funnelHtml(m, d.same_type, `${d.type_name}均值`)}</div>
      <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">漏斗掉点诊断</h3><span class="grow"></span>
        <div class="mode-toggle"><button type="button" class="mode-btn ${diagId === 'type' ? 'on' : ''}" data-dx="lpdiag|type">对比同类页面</button><button type="button" class="mode-btn ${diagId === 'site' ? 'on' : ''}" data-dx="lpdiag|site">对比全部落地页</button></div></div>
        <div id="lpdiag">${diagHtml(diagId === 'site' ? d.diag_site : d.diag_type)}</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>消耗与 ROAS 趋势 <span class="h-note">过去 30 日</span></h3>${trendSvg(m.trend_30)}</div>
      <div class="card"><h3>本页创意适配 <span class="h-note">×适配 = 该标签在本页的相对表现 ÷ 其在全站的相对表现，剔除标签本身强弱；按消耗加权排序，点击查看明细</span></h3>
        <h4 class="sub-h up">适合投到本页</h4>${d.fit_good.map(fitRow).join('') || '<div class="adv-none">暂无明显更适合的创意标签</div>'}
        <h4 class="sub-h down">不适合投到本页</h4>${d.fit_bad.map(fitRow).join('') || '<div class="adv-none">暂无明显不适合的创意标签</div>'}</div>
    </div>
    <div class="card"><h3>本页素材标签拆解 <span class="h-note">本页内各创意标签的漏斗与 ROAS</span></h3>${dxBlock('lpdims', d.dims, m, '创意方向')}</div>
    <div class="card"><h3>投放到本页的素材（${d.assets.length}）</h3>${assetTable(d.assets, m)}</div>
    <div class="grid2">
      <div class="card"><h3>本页承接的商品</h3>${spuMiniTable(d.products, m)}</div>
      <div class="card"><h3>同类页面对比 <span class="h-note">${esc(d.type_name)}</span></h3>
        <table class="t ent"><thead><tr><th>落地页</th><th class="num">消耗</th><th class="num">ROAS</th><th class="num">加购率</th><th class="num">CVR</th><th></th></tr></thead><tbody>
        ${d.peers.map((x) => `<tr class="clickable ${x.current ? 'cur' : ''}" data-go="${goHref('lp', x.lp)}"><td><b class="mono">${esc(lpParts(x.lp).path)}</b>${x.name ? `<div class="small muted">${esc(x.name)}</div>` : ''}</td>
          <td class="num">${fmtMoney(x.spend)}</td><td class="num ${roasCls(x.roas, d.same_type.roas)}"><b>${fmtRoas(x.roas)}</b></td><td class="num">${fmtPct(x.atc_rate)}</td><td class="num">${fmtPct(x.cvr)}</td><td class="go">›</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  DX.lpdiag = () => {
    const site = AN.dx.lpdiag === 'site';
    $('#lpdiag').innerHTML = diagHtml(site ? d.diag_site : d.diag_type);
    $$('[data-dx^="lpdiag|"]').forEach((b) => b.classList.toggle('on', b.dataset.dx === `lpdiag|${site ? 'site' : 'type'}`));
  };
}

/* ---------- 商品（SPU）分析 ---------- */

function spuCard(p, s) {
  return `<div class="lc-card" data-go="${goHref('spu', p.product_id)}">
    <div class="lc-top">${p.image ? `<img src="${esc(p.image)}">` : '<div class="th sm"></div>'}<div class="lc-name"><b class="mono">${esc(p.spu)}</b><div class="small muted ellip">${esc(p.title)}</div></div></div>
    <div class="lc-m"><span>GMV <b>${fmtMoneyK(p.revenue)}</b></span><span>ROAS <b class="${roasCls(p.roas, s.roas)}">${fmtRoas(p.roas)}</b></span><span>7日 ${growthHtml(p.rev_growth)}</span></div>
    <div class="lc-spark">${sparkLine(p.trend_30, 'revenue', { w: 200, h: 24 })}</div>
    ${p.reason ? `<div class="lc-reason">${esc(p.reason)}</div>` : ''}
    ${p.win_tags.length ? `<div class="lc-tags">${p.win_tags.map((t) => chipHtml(t.dim_name, t.label)).join('')}</div>` : ''}</div>`;
}

function drawSpuOverview(body, d) {
  const s = d.summary, c = d.counts;
  const order = ['breakout', 'hot', 'new', 'potential', 'decline', 'steady'];
  const board = order.map((st) => {
    const l = d.products.filter((p) => p.status === st);
    if (!l.length && (st === 'steady' || st === 'potential')) return '';
    return `<div class="lc-col"><div class="lc-h">${stBadge(st)}<b>${l.length}</b><span class="small muted">${SPU_ST[st][2]}</span></div>
      ${l.map((p) => spuCard(p, s)).join('') || '<div class="adv-none">暂无</div>'}</div>`;
  }).join('');
  const ftRow = (f, a, b, la, lb, roas) => `<div class="ft-row" title="${esc(f.dim_name)}：${esc(f.label)}"><div class="ft-l">${chipHtml(f.dim_name, f.label)}</div>
      <div class="ft-bars"><div class="ft-b a"><i style="width:${Math.min(100, a * 100)}%"></i><span>${la} ${fmtShare(a)}</span></div><div class="ft-b b"><i style="width:${Math.min(100, b * 100)}%"></i><span>${lb} ${fmtShare(b)}</span></div></div>
      <div class="ft-r">${roas}</div></div>`;
  const feats = d.features.map((f) => ftRow(f, f.share_win, f.share_other, '爆品', '其他', `<span class="roas-good">ROAS ${fmtRoas(f.roas_win)}</span>`)).join('') || '<div class="adv-none">暂未发现显著共性（需要至少一个热卖 / 爆款商品）</div>';
  const chg = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
  const cause = (f) => {
    const ctr = f.prior_ctr && f.recent_ctr != null ? f.recent_ctr / f.prior_ctr - 1 : 0;
    const cvr = f.prior_cvr && f.recent_cvr != null ? f.recent_cvr / f.prior_cvr - 1 : 0;
    return ctr < cvr ? `点击率 ${chg(ctr)}，创意吸引力下降` : `转化率 ${chg(cvr)}，承接 / 卖点说服力下降`;
  };
  const warns = d.decline_features.map((f) => `<div class="adv-row"><div class="adv-main">${chipHtml(f.dim_name, f.label)}</div>
      <div class="adv-meta">${f.assets} 素材 · 7日消耗 ${fmtMoney(f.prior_spend)} → ${fmtMoney(f.recent_spend)} · ${cause(f)}${f.also.length ? `<br>同一批素材还带有：${f.also.map((x) => esc(x.label)).join('、')}` : ''}</div>
      <div class="adv-r roas-bad">${fmtRoas(f.prior_roas)} → ${fmtRoas(f.recent_roas)}<em class="down">${chg(f.drop)}</em></div></div>`).join('')
    || `<div class="adv-none">${c.decline ? '衰退款的创意标签暂无明显疲劳' : '暂无衰退款'}</div>`;
  const groups = `<table class="t"><thead><tr><th>品类</th><th class="num">SPU</th><th style="width:30%">GMV 占比</th><th class="num">订单</th><th class="num">ROAS</th></tr></thead><tbody>
    ${d.groups.map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.spus}</td><td>${bar(g.revenue, s.revenue, '#f3d9b1', `${fmtMoneyK(g.revenue)} · ${fmtShare(g.revenue / (s.revenue || 1))}`)}</td><td class="num">${fmtOrders(g.conversions)}</td><td class="num ${roasCls(g.roas, s.roas)}">${fmtRoas(g.roas)}</td></tr>`).join('')}</tbody></table>`;
  body.innerHTML = `${kpiHtml([['在投 SPU', d.products.length], ['GMV', fmtMoney(s.revenue)], ['订单', fmtOrders(s.conversions)], ['ROAS', fmtRoas(s.roas)], ['爆款 / 热卖', `${c.breakout} / ${c.hot}`], ['衰退', c.decline, c.decline ? 'roas-bad' : '']])}
    <div class="card"><h3>商品生命周期看板 <span class="h-note">按近 7 日 vs 前 7 日的 GMV、ROAS 与上线天数自动分类；卡片底部为该商品素材中的制胜标签</span></h3><div class="lc-board">${board}</div></div>
    <div class="grid2">
      <div class="card"><h3>爆品素材共性 <span class="h-note">热卖 / 爆款商品的素材中，明显更常用且 ROAS 达标的标签 → 可复制到新品与潜力款</span></h3>${feats}</div>
      <div class="card"><h3>衰退款素材疲劳诊断 <span class="h-note">衰退商品的各创意标签：近7日 vs 前7日 ROAS，定位是哪类素材在失效，并区分是吸引力还是转化问题</span></h3>${warns}
        <h3 style="margin-top:18px">品类表现</h3>${groups}</div>
    </div>
    <div class="card"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">商品列表</h3><span class="h-note">点击行查看单品的宣传方向、素材动态与落地页对比</span>
      <span class="grow"></span><select id="entStatus"><option value="all">全部状态</option>${order.map((k) => `<option value="${k}">${SPU_ST[k][0]}</option>`).join('')}</select>
      <input id="entQ" placeholder="搜索 SPU / 标题" value="${esc(AN.q.spu)}" style="width:180px">
      <select id="entSort"><option value="revenue">按 GMV</option><option value="roas">按 ROAS</option><option value="growth">按近7日 GMV 增速</option><option value="delta">按近7日 ROAS 变化</option><option value="assets">按素材数</option></select></div>
      <div id="entTable"></div></div>`;
  const tot = s.revenue || 1;
  bindList('spu', d.products, (list) => `<div style="overflow:auto"><table class="t ent"><thead><tr><th></th><th>SPU</th><th>状态</th><th>GMV · 占比</th><th class="num">订单</th><th class="num">ROAS</th>
      <th class="num">客单价</th><th class="num">CVR</th><th class="num">近7日 GMV</th><th class="num">近7日 ΔROAS</th><th class="num">素材</th><th>制胜标签</th><th>30日趋势</th><th></th></tr></thead><tbody>
    ${list.map((p) => `<tr class="clickable" data-go="${goHref('spu', p.product_id)}">
      <td>${p.image ? `<img class="th sm" src="${esc(p.image)}">` : '<div class="th sm"></div>'}</td>
      <td><b class="mono">${esc(p.spu)}</b><div class="small muted ellip">${esc(p.title)}${p.product_type ? ' · ' + esc(p.product_type) : ''}</div></td>
      <td title="${esc(p.reason)}">${stBadge(p.status)}</td>
      <td style="min-width:140px">${bar(p.revenue, tot, '#f3d9b1', `${fmtMoneyK(p.revenue)} · ${fmtShare(p.revenue / tot)}`)}</td>
      <td class="num">${fmtOrders(p.conversions)}</td><td class="num ${roasCls(p.roas, s.roas)}"><b>${fmtRoas(p.roas)}</b></td><td class="num">${fmtMoney(p.aov)}</td><td class="num">${fmtPct(p.cvr)}</td>
      <td class="num">${growthHtml(p.rev_growth)}</td><td class="num">${deltaHtml(p.delta_roas)}</td><td class="num">${p.assets}</td>
      <td class="win-cell">${p.win_tags.map((t) => chipHtml(t.dim_name, t.label)).join('')}</td>
      <td>${trendCell(p.trend_30, 'revenue', 'GMV')}</td><td class="go">›</td></tr>`).join('')}</tbody></table></div>`,
  (v) => `${v.spu} ${v.title}`,
  { revenue: (v) => v.revenue, roas: (v) => v.roas ?? -1, growth: (v) => v.rev_growth ?? -99, delta: (v) => v.delta_roas ?? -99, assets: (v) => v.assets });
}

function drawSpuDetail(body, d) {
  const p = d.product, st = d.status || {}, m = d.summary;
  const briefText = `${p.spu} 素材 Brief：` + d.brief.map((b) => `${b.dim_name}=${b.label}`).join('；');
  const moveRow = (a) => `<div class="mv-row"><div class="mv-n"><code class="mono">${esc(a.short_name)}</code> <span class="small muted">${(a.labels || []).slice(0, 3).map((l) => esc(l.label)).join(' · ')}</span></div>
      <div class="mv-m small muted">ROAS ${fmtRoas(a.prior7.roas)} → <b>${fmtRoas(a.recent7.roas)}</b> · 近7日消耗 ${fmtMoney(a.recent7.spend)}</div><div class="mv-d">${deltaHtml(a.delta_roas)}</div></div>`;
  const rec = st.recent7 || {}, pri = st.prior7 || {};
  body.innerHTML = `<div class="drill-head"><a class="back" href="#/analytics/spu">← 全部商品</a>
      ${p.image ? `<img src="${esc(p.image)}">` : ''}<div class="dh-main"><div class="dh-t mono">${esc(p.spu)} ${stBadge(st.status)}</div><div class="small muted">${esc(p.title)}${p.product_type ? ' · ' + esc(p.product_type) : ''}${st.reason ? ' · ' + esc(st.reason) : ''}</div></div>
      <span class="grow"></span>${p.url ? `<a class="small" href="${esc(p.url)}" target="_blank" rel="noopener">商品页 ↗</a>` : ''}</div>
    ${kpiHtml([['GMV', fmtMoney(m.revenue)], ['订单', fmtOrders(m.conversions)], ['ROAS', fmtRoas(m.roas), roasCls(m.roas, d.site.roas)], ['客单价', fmtMoney(m.aov)], ['点击→购买 CVR', fmtPct(m.cvr)], ['在投素材', m.assets]])}
    <div class="grid2">
      <div class="card"><h3>GMV 与 ROAS 趋势 <span class="h-note">近7日 GMV ${fmtMoney(rec.revenue)}（前7日 ${fmtMoney(pri.revenue)}，${growthHtml(st.rev_growth)}）</span></h3>${trendSvg(m.trend_30, { key: 'revenue', name: '日 GMV' })}</div>
      <div class="card"><h3>转化漏斗与掉点 <span class="h-note">对比全部商品均值</span></h3>${funnelHtml(m, d.site, '全部商品均值')}<div style="margin-top:10px">${diagHtml(d.diag)}</div></div>
    </div>
    <div class="card"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">宣传方向</h3><span class="h-note">从本商品已投素材中提炼：每个字段取 ROAS 最高、且消耗占比 ≥8% 的标签</span><span class="grow"></span>
      ${d.brief.length ? `<button class="btn inline" id="copyBrief">复制 Brief 给设计师</button>` : ''}</div>
      <div class="brief">${d.brief.map((b) => `<div class="brief-i" data-dx="spudims|${esc(b.dim)}" title="查看「${esc(b.dim_name)}」拆解"><span class="muted small">${esc(b.dim_name)}</span><b>${esc(b.label)}</b>
        <span class="small">ROAS ${fmtRoas(b.roas)} <em class="up">×${b.index.toFixed(2)}</em> · ${b.assets} 素材</span></div>`).join('') || '<div class="adv-none">样本不足，暂无法提炼</div>'}</div>
      <h4 class="sub-h" style="margin-top:14px">待测试方向 <span class="small muted" style="font-weight:400">其他商品已验证有效、本商品尚未尝试（消耗占比 &lt;5%）</span></h4>
      ${d.to_test.map((t) => `<div class="adv-row"><div class="adv-main">${chipHtml(t.dim_name, t.label)}</div><div class="adv-meta">${t.spus} 个商品验证 · 本商品占比 ${fmtShare(t.my_share)}</div>
        <div class="adv-r roas-good">${fmtRoas(t.roas_other)}<em class="up">+${(t.lift * 100).toFixed(0)}%</em></div></div>`).join('') || '<div class="adv-none">暂无：本商品已覆盖其他商品验证有效的方向</div>'}</div>
    <div class="grid2">
      <div class="card"><h3>走强素材 <span class="h-note">近7日 ROAS 明显提升，可加预算 / 做衍生版本</span></h3>${d.rising.map(moveRow).join('') || '<div class="adv-none">暂无</div>'}</div>
      <div class="card"><h3>疲劳素材 <span class="h-note">近7日 ROAS 明显下滑，建议替换或迭代</span></h3>${d.fatigue.map(moveRow).join('') || '<div class="adv-none">暂无</div>'}</div>
    </div>
    <div class="card"><h3>本商品的创意标签拆解</h3>${dxBlock('spudims', d.dims, m, '卖点')}</div>
    <div class="card"><h3>素材排行（${d.assets.length}）</h3>${assetTable(d.assets, m, { lps: true })}</div>
    <div class="card"><h3>落地页对比 <span class="h-note">本商品导向不同落地页的漏斗差异</span></h3>${lpTable(d.lps, m, { compact: true })}</div>
    ${d.peers.length > 1 ? `<div class="card"><h3>同品类商品对比 <span class="h-note">${esc(p.product_type || '未分类')}</span></h3>
      <table class="t ent"><thead><tr><th>SPU</th><th>状态</th><th class="num">GMV</th><th class="num">ROAS</th><th class="num">CVR</th><th class="num">近7日 GMV</th><th>制胜标签</th><th></th></tr></thead><tbody>
      ${d.peers.map((x) => `<tr class="clickable ${x.product_id === p.product_id ? 'cur' : ''}" data-go="${goHref('spu', x.product_id)}"><td><b class="mono">${esc(x.spu)}</b><div class="small muted ellip">${esc(x.title)}</div></td>
        <td>${stBadge(x.status)}</td><td class="num">${fmtMoney(x.revenue)}</td><td class="num ${roasCls(x.roas, d.site.roas)}"><b>${fmtRoas(x.roas)}</b></td><td class="num">${fmtPct(x.cvr)}</td>
        <td class="num">${growthHtml(x.rev_growth)}</td><td class="win-cell">${x.win_tags.map((t) => chipHtml(t.dim_name, t.label)).join('')}</td><td class="go">›</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  const cb = $('#copyBrief');
  if (cb) cb.onclick = () => { copy(briefText); toast('已复制 Brief', 'ok'); };
}

/* ------------------------------------------------------------------ 路由 */

const PAGES = { upload: pageUpload, assets: pageAssets, analytics: pageAnalytics, spec: pageSpec, products: pageProducts, settings: pageSettings };

async function route() {
  const page = (location.hash.replace('#/', '') || (STATIC_DEMO ? 'analytics' : 'upload')).split(/[/?]/)[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  const main = $('#main');
  main.onchange = null; main.onclick = null;
  try { await (PAGES[page] || pageUpload)(main); } catch (e) { fail(e); }
}

window.addEventListener('hashchange', route);
(async () => {
  try { await loadState(); await loadProducts(); } catch (e) { fail(e); }
  route();
})();
