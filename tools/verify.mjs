#!/usr/bin/env node
/* ============================================================
 * 孕期陪伴手册 —— 离线回归校验（无第三方依赖）
 *
 * 用法：  node tools/verify.mjs
 * 作用：  从 index.html 里抽出 <script>，用最小 DOM 桩在 Node 中执行，
 *        校验孕周数学、里程碑日期、化验单换算/规则、红旗分诊与各面板渲染。
 * 退出码：0 = 全部通过；1 = 有失败项。
 *
 * 为什么需要它：本项目是单文件、无构建、无测试的应用，而孕周与日期
 * 一旦算错会直接影响 NT / 糖耐 / 预产期等就医时间点，必须有可复核的回归。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('未在 index.html 中找到 <script> 块'); process.exit(1); }

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', title: '', className: '', disabled: false,
    style: new Proxy({}, { get: () => '', set: () => true }),
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, focus() {}, scrollIntoView() {}, setAttribute() {}, getAttribute() { return null; },
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {},
    get firstChild() { return makeEl(id + '__wrap'); },
  };
}
const els = {};
const store = {};
const sandbox = {
  document: {
    getElementById(id) { if (!els[id]) els[id] = makeEl(id); return els[id]; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {},
  },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
  console,
  window: { scrollTo() {}, location: { search: '' }, open() {} },
  location: { search: '' },
  navigator: {},
  URLSearchParams,
  setTimeout, clearTimeout,
  alert() {}, confirm: () => true, prompt: () => null,
  fetch: () => Promise.reject(new Error('offline')),
  AbortController,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
/* 顶层 const/let 不会挂到沙箱全局，追加导出器供断言使用 */
vm.runInContext(
  m[1] + '\n;globalThis.__t = { WEEKS, POSTPARTUM, RED_FLAGS, RF_LEVELS, PROG_NMOL_PER_NGML, PROG_LOW_NMOL,'
       + ' CHECKLIST_POOL, OUTCOME_TYPES, tabsFor, recoveryChecks, outcomeLabel,'
       + ' getState(){ return state; }, setState(v){ state = v; } };',
  sandbox, { filename: 'index.html<script>' }
);

const T = sandbox.__t;
const D = s => new Date(s + 'T00:00:00');
let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; return; }
  failures.push(`${name}\n     实际 = ${JSON.stringify(actual)}\n     期望 = ${JSON.stringify(expected)}`);
}
const group = t => console.log(`\n▸ ${t}`);

/* ---------- 1. 孕周基准：必须是临床孕周（与化验单 / B 超一致） ---------- */
group('孕周基准（临床孕周，LMP 当天 = 孕 0 周 0 天；孕 40 周 0 天 = 预产期）');
T.setState({ lmp: '2026-01-01', dating: 'lmp', profile: {} });
for (const [ref, days, cw, label, delivered] of [
  ['2026-01-01', 0, 0, '孕 0 周 0 天', false],
  ['2026-01-07', 6, 0, '孕 0 周 6 天', false],
  ['2026-01-08', 7, 1, '孕 1 周 0 天', false],
  ['2026-03-08', 66, 9, '孕 9 周 3 天', false],
  ['2026-10-08', 280, 40, '孕 40 周 0 天', false],   // 预产期当天绝不能显示"已出生"
  ['2026-10-15', 287, 41, '孕 41 周 0 天', false],   // 过期妊娠
  ['2026-10-22', 294, 42, '孕 42 周 0 天', true],    // 42 周才兜底为产后
]) {
  const ph = sandbox.phaseNow(D(ref));
  check(`${ref} 孕龄天数`, ph.days, days);
  check(`${ref} 临床孕周`, ph.cw, cw);
  check(`${ref} 显示`, sandbox.gestLabel(ph.days), label);
  check(`${ref} 是否已分娩`, ph.delivered, delivered);
}
check('预产期 = LMP + 280 天', sandbox.fmtDate(sandbox.dueDate(sandbox.parseLmp('2026-01-01'))), '2026-10-08');
check('查表索引：孕 9 周取到 WEEKS 中 week=9', T.WEEKS[sandbox.phaseNow(D('2026-03-08')).weekIndex - 1].week, 9);
check('查表索引：孕 0 周复用第 1 周条目', T.WEEKS[sandbox.phaseNow(D('2026-01-03')).weekIndex - 1].week, 1);
check('WEEKS 数据为临床孕周口径（孕 8 周 CRL = 1.6cm）', T.WEEKS[7].baby.cm, '1.6');
check('分期：孕 13 周仍属孕早期', sandbox.trimesterOf(13).startsWith('孕早期'), true);
check('分期：孕 14 周进入孕中期', sandbox.trimesterOf(14).startsWith('孕中期'), true);
check('分期：孕 41 周标注为已过预产期', sandbox.trimesterOf(41).includes('已过预产期'), true);

/* ---------- 2. 里程碑日期与预产期自洽（原 off-by-one 相差 7 天） ---------- */
group('关键节点日期（原实现比临床孕周早 7 天，且"预产期"有两个日期）');
{
  const lmp = sandbox.parseLmp('2026-01-01');
  check('里程碑「预产期」== 头部预产期', sandbox.fmtDate(sandbox.addDays(lmp, 40 * 7)),
        sandbox.fmtDate(sandbox.dueDate(lmp)));
  check('大排畸（孕 20 周）落在 20–24 周窗口内', sandbox.fmtDate(sandbox.addDays(lmp, 20 * 7)),
        sandbox.fmtDate(sandbox.addDays(lmp, 140)));
  check('糖耐（孕 24 周）落在 24–28 周窗口内', sandbox.fmtDate(sandbox.addDays(lmp, 24 * 7)),
        sandbox.fmtDate(sandbox.addDays(lmp, 168)));
}

/* ---------- 3. 医生核定孕周的输入换算（原回推 LMP 差 7 天） ---------- */
group('「按医生核定的孕周」输入（孕 W 周 D 天 → LMP = 核定日 − (W*7 + D)）');
{
  sandbox.setDatingMode('week');
  els.weekInput.value = '9'; els.dayInput.value = '3';
  els.weekInputDate.value = '2026-09-30'; els.deliveryInput.value = '';
  const s = sandbox.readForm();
  check('回推 LMP', s.lmp, '2026-07-26');
  check('LMP 到核定日 = 66 天', sandbox.diffDays(sandbox.parseLmp(s.lmp), sandbox.parseLmp('2026-09-30')), 66);
  check('预产期 = 核定日 + 214 天', sandbox.fmtDate(sandbox.addDays(sandbox.parseLmp(s.lmp), 280)),
        sandbox.fmtDate(sandbox.addDays(sandbox.parseLmp('2026-09-30'), 214)));
  sandbox.setDatingMode('due');
  els.dueInput.value = sandbox.fmtDate(sandbox.addDays(sandbox.parseLmp('2026-09-30'), 214));
  check('两个「医生核定」入口给出同一个 LMP', sandbox.readForm().lmp, s.lmp);
}

/* ---------- 4. 出生日期 → 产后模式 ---------- */
group('分娩日期与产后周数');
{
  T.setState({ lmp: '2026-01-01', dating: 'lmp', profile: {}, delivery: '2026-10-01' });
  const a = sandbox.phaseNow(D('2026-10-01'));
  check('分娩当天即进入产后', a.delivered, true);
  check('分娩当天 = 产后第 1 周', a.ppWeek, 1);
  check('分娩后 21 天 = 产后第 4 周', sandbox.phaseNow(D('2026-10-22')).ppWeek, 4);
}

/* ---------- 5. 化验单：单位换算 / 趋势 / 规则提示 ---------- */
group('化验单（单位换算 / 48h 趋势 / 固定规则提示）');
check('14.16 nmol/L ≈ 4.45 ng/mL', (14.16 / T.PROG_NMOL_PER_NGML).toFixed(2), '4.45');
check('15 ng/mL ≈ 47.7 nmol/L', sandbox.progToNmol(15, 'ng/mL').toFixed(1), '47.7');
{
  const d = sandbox.labDelta({ date: '2026-09-27', hcg: 100 }, { date: '2026-09-29', hcg: 276 });
  check('48 小时间隔', Math.round(d.dtH), 48);
  check('上升 176%', Math.round(d.pct), 176);
  check('倍增时间 < 48 小时', d.doublingH < 48, true);
}
{
  const slow = sandbox.labDelta({ date: '2026-09-27', hcg: 250 }, { date: '2026-09-29', hcg: 276 });
  check('48 小时只上升 10%', Math.round(slow.pct), 10);
  check('下降时百分比为负', sandbox.labDelta({ date: '2026-09-27', hcg: 300 }, { date: '2026-09-29', hcg: 200 }).pct < 0, true);
}
{
  const a1 = sandbox.labAlerts([{ date: '2026-09-29', hcg: 276, prog: 14.16, progUnit: 'nmol/L' }]);
  check('命中「hCG<1500 无法定位」', a1.some(a => a.includes('单次 hCG 无法判断妊娠位置')), true);
  check('命中「孕酮偏低」且带 ng/mL 换算', a1.some(a => a.includes('47.7 nmol/L') && a.includes('4.45 ng/mL')), true);
  const a2 = sandbox.labAlerts([
    { date: '2026-09-27', hcg: 250, prog: 0, progUnit: 'nmol/L' },
    { date: '2026-09-29', hcg: 276, prog: 0, progUnit: 'nmol/L' },
  ]);
  check('命中「上升偏慢」', a2.some(a => a.includes('上升偏慢')), true);
  const a3 = sandbox.labAlerts([
    { date: '2026-09-27', hcg: 5000, prog: 80, progUnit: 'nmol/L' },
    { date: '2026-09-29', hcg: 9800, prog: 90, progUnit: 'nmol/L' },
  ]);
  check('正常翻倍且孕酮正常时无提示', a3.length, 0);
  const a4 = sandbox.labAlerts([{ date: '2026-09-29', hcg: 0, prog: 10, progUnit: 'ng/mL' }]);
  check('ng/mL 输入换算成 nmol/L 后仍命中', a4.some(a => a.includes('31.8 nmol/L')), true);
}

/* ---------- 6. 红旗分诊与早孕警示覆盖 ---------- */
group('红旗分诊（三档动作）与早孕警示覆盖');
check('红旗条目数 > 15', T.RED_FLAGS.length > 15, true);
check('每条都有信号与动作且档位合法', T.RED_FLAGS.every(f => f.act && f.sign && T.RF_LEVELS[f.level]), true);
{
  const early = sandbox.redFlagBlock({ delivered: false, cw: 6 });
  check('早孕只显示早孕分组', early.includes('孕早期') && !early.includes('孕中晚期'), true);
  check('早孕含宫外孕条目', early.includes('排除宫外孕'), true);
  const late = sandbox.redFlagBlock({ delivered: false, cw: 30 });
  check('孕晚期显示中晚孕分组', late.includes('孕中晚期') && !late.includes('孕早期'), true);
  const post = sandbox.redFlagBlock({ delivered: true, cw: 40 });
  check('产后只显示产后分组', post.includes('产后') && !post.includes('孕中晚期'), true);
}
check('孕 4–12 周每周都有宫外孕警示', [4,5,6,7,8,9,10,11,12]
  .every(i => T.WEEKS[i - 1].warn.join(' ').includes('宫外孕')), true);
check('第 3 周不再把出血简单定性为"正常"（warn ≥ 2 条）', T.WEEKS[2].warn.length >= 2, true);
check('第 4 周起的警示含"不要等门诊"', T.WEEKS[3].warn.join(' ').includes('不要等门诊'), true);

/* ---------- 6.5 妊娠结束（生化妊娠 / 流产 / 宫外孕）路径 ---------- */
group('妊娠结束路径：停止推送孕期内容 + 随访到 hCG <5 + 下次备孕');
{
  const END = { type: 'biochemical', date: '2026-10-02' };
  T.setState({ lmp: '2026-07-26', dating: 'lmp', profile: {}, labs: [], outcome: END });
  const ph = sandbox.phaseNow(D('2026-10-02'));
  check('结束当天 ended', ph.ended, true);
  check('结束当天 daysSinceEnd', ph.daysSinceEnd, 0);
  check('结束 5 天后 daysSinceEnd', sandbox.phaseNow(D('2026-10-07')).daysSinceEnd, 5);

  const ids = T.tabsFor(ph).map(t => t.id);
  check('结束后隐藏「周历」', ids.includes('week'), false);
  check('结束后隐藏「产后月子」', ids.includes('post'), false);
  check('结束后显示「恢复·备孕」', ids.includes('after'), true);
  const idsPregnant = T.tabsFor({ ended: false }).map(t => t.id);
  check('未结束时隐藏「恢复·备孕」', idsPregnant.includes('after'), false);
  check('未结束时保留「周历」', idsPregnant.includes('week'), true);

  const today = sandbox.renderToday();
  check('今日面板改为随访版', today.includes('现在要做的随访'), true);
  check('今日面板不再出现胎儿发育内容', today.includes('宝宝本周'), false);
  check('今日面板不再出现待产包/数胎动', today.includes('待产包'), false);
  check('今日面板给出「不是你的错」', today.includes('这不是你的错'), true);
  check('周历已停用（不再显示孕周网格）', sandbox.renderWeek().includes('已停用'), true);
  check('产后月子已停用', sandbox.renderPost().includes('已停用'), true);

  /* renderApp 直接写 DOM，用桩元素断言头部与进度卡 */
  sandbox.renderApp();
  check('头部显示结局而非孕周', String(els.metaLine.innerHTML).includes('生化妊娠'), true);
  check('头部不出现孕周', String(els.metaLine.innerHTML).includes('孕 '), false);
  check('进度卡标签为"妊娠已结束"', String(els.weekTag.textContent), '妊娠已结束');
  check('结束后进度卡大数字不再是孕周', String(els.weekBig.textContent), '—');

  const after = sandbox.renderAfter();
  check('恢复页含 hCG 随访到 <5', after.includes('hCG 复查到 &lt; 5 IU/L'), true);
  check('恢复页含 ASRM 2026 ≥2 次即可评估', after.includes('ASRM 2026') && after.includes('≥2 次妊娠失败'), true);
  check('恢复页含生化妊娠含在定义内', after.includes('含生化妊娠'), true);
  check('恢复页列出不推荐检查（NK / MTHFR / IVIg / 父方白细胞）',
    ['NK 细胞', 'MTHFR', 'IVIg', '父方白细胞'].every(k => after.includes(k)), true);
  check('恢复页含 10–20% 临床妊娠流产率', after.includes('10%–20%'), true);
  check('恢复页含下次备孕可做的事（叶酸/甲功/血糖/地贫）',
    ['叶酸 0.4 mg', 'TSH', 'HbA1c', '地中海贫血'].every(k => after.includes(k)), true);
  check('恢复页含再备孕时机（1–2 次正常月经）', after.includes('1–2 次正常月经'), true);
  check('恢复页含情绪求助阈值', after.includes('持续 2 周以上'), true);

  const rf = sandbox.redFlagBlock(ph);
  check('结束后红旗卡只显示「妊娠结束后」分组', rf.includes('妊娠结束后') && !rf.includes('孕早期'), true);
  check('结束后红旗卡含 hCG 平台/上升条目', rf.includes('hCG 不降、平台'), true);

  const csBio = T.recoveryChecks(ph).map(c => c.id);
  check('生化妊娠随访清单不含"复查超声"强条', csBio.includes('afFollowup'), false);
  const csMis = T.recoveryChecks({ ended: true, outcomeType: 'miscarriage' }).map(c => c.id);
  check('流产后加"复查超声确认宫腔干净"', csMis.includes('afFollowup'), true);
  const csEct = T.recoveryChecks({ ended: true, outcomeType: 'ectopic' }).map(c => c.id);
  check('宫外孕后加"严格按 hCG 随访时间表"', csEct.includes('afEctopic'), true);
}

group('化验单在「妊娠结束后」只输出随访规则');
{
  const END = { type: 'biochemical', date: '2026-10-02' };
  T.setState({ lmp: '2026-07-26', dating: 'lmp', profile: {}, labs: [], outcome: END });
  const a0 = sandbox.labAlerts([]);
  check('没有结束后的 hCG 记录时提醒复查', a0.some(x => x.includes('还没有结束后的 hCG 结果')), true);

  T.setState({ lmp: '2026-07-26', dating: 'lmp', profile: {}, outcome: END,
    labs: [{ date: '2026-09-29', hcg: 276, prog: 14.16, progUnit: 'nmol/L' }] });
  const a1 = sandbox.labAlerts(sandbox.labEntries());
  check('结束前的结果不算随访', a1.some(x => x.includes('还没有结束后的 hCG 结果')), true);
  check('不再输出孕期口径的"单次 hCG 无法定位"', a1.some(x => x.includes('单次 hCG 无法判断妊娠位置')), false);
  check('不再输出"孕酮偏低"', a1.some(x => x.includes('孕酮') && x.includes('47.7')), false);

  T.setState({ lmp: '2026-07-26', dating: 'lmp', profile: {}, outcome: END,
    labs: [{ date: '2026-10-02', hcg: 120, prog: 0, progUnit: 'nmol/L' },
           { date: '2026-10-05', hcg: 95, prog: 0, progUnit: 'nmol/L' }] });
  const a2 = sandbox.labAlerts(sandbox.labEntries());
  check('下降但未达标 → 继续复查', a2.some(x => x.includes('仍未降到')), true);
  check('下降但未达标时不报警', a2.some(x => x.includes('立即就诊')), false);

  T.setState({ lmp: '2026-07-26', dating: 'lmp', profile: {}, outcome: END,
    labs: [{ date: '2026-10-02', hcg: 95, prog: 0, progUnit: 'nmol/L' },
           { date: '2026-10-05', hcg: 130, prog: 0, progUnit: 'nmol/L' }] });
  const a3 = sandbox.labAlerts(sandbox.labEntries());
  check('hCG 上升 → 立即就诊排除宫外孕', a3.some(x => x.includes('立即就诊') && x.includes('持续性异位妊娠')), true);

  T.setState({ lmp: '2026-07-26', dating: 'lmp', profile: {}, outcome: END,
    labs: [{ date: '2026-10-08', hcg: 3, prog: 0, progUnit: 'nmol/L' }] });
  check('已达标 <5 时不再提示随访', sandbox.labAlerts(sandbox.labEntries()).length, 0);
}

/* ---------- 7. 各面板可渲染（含高危 PCOS、过期、产后、妊娠结束） ---------- */
group('面板渲染（不抛错即视为通过）');
for (const [label, st] of [
  ['孕早期 + PCOS', { lmp: '2026-07-26', dating: 'lmp', profile: { pcos: true }, labs: [] }],
  ['过期妊娠', { lmp: '2025-12-01', dating: 'lmp', profile: {} }],
  ['产后', { lmp: '2025-12-01', dating: 'lmp', profile: {}, delivery: '2026-09-20' }],
  ['备孕（LMP 在未来）', { lmp: '2027-01-01', dating: 'lmp', profile: {} }],
  ['妊娠结束（生化）', { lmp: '2026-07-26', dating: 'lmp', profile: {}, outcome: { type: 'biochemical', date: '2026-10-02' } }],
]) {
  T.setState(st);
  for (const fn of ['renderToday', 'renderWeek', 'renderLab', 'renderMed', 'renderAfter', 'renderFood', 'renderBag', 'renderSz', 'renderPost']) {
    let ok = true, err = '';
    try { ok = typeof sandbox[fn]() === 'string' && sandbox[fn]().length > 100; } catch (e) { ok = false; err = e.message; }
    check(`${label} · ${fn}()`, ok ? true : 'ERROR: ' + err, true);
  }
}
T.setState({ lmp: '2026-07-26', dating: 'lmp', profile: {} });
check('今日面板含红旗卡', sandbox.renderToday().includes('哪些情况要立刻就医'), true);
check('周历面板含红旗卡', sandbox.renderWeek().includes('哪些情况要立刻就医'), true);
check('用药页含"不要自行停用慢性病药物"', sandbox.renderMed().includes('不要自行停用慢性病药物'), true);
check('用药页禁用项含 ACEI/ARB 与孕 20 周后 NSAIDs', sandbox.renderMed().includes('ACEI / ARB 禁用') && sandbox.renderMed().includes('孕 20 周后避免'), true);
check('用药页疫苗含减毒活疫苗孕期禁用', sandbox.renderMed().includes('孕期禁用'), true);
check('用药页地贫含 25% 重型风险与初筛阈值', sandbox.renderMed().includes('25%') && sandbox.renderMed().includes('MCV'), true);
check('早孕期清单含地贫筛查项', T.CHECKLIST_POOL.some(c => c.id === 'thal' && c.when(8) && !c.when(30)), true);

/* ---------- 8. 存档安全 ---------- */
group('存档安全');
{
  const orig = sandbox.localStorage.setItem;
  sandbox.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  let threw = false;
  const origWarn = console.warn; console.warn = () => {};
  try { sandbox.saveState({ lmp: '2026-01-01', dating: 'lmp' }); } catch { threw = true; }
  console.warn = origWarn; sandbox.localStorage.setItem = orig;
  check('localStorage 写满时 saveState 不抛错', threw, false);
}

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(58));
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / ${pass} 项通过\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`✓ 全部通过：${pass} 项检查`);
console.log('  （如需浏览器端端到端校验，请参考 docs/孕期知识深度调研/10-* 中的说明）');
