#!/usr/bin/env node
/* ============================================================
 * 孕期陪伴手册 —— 浏览器端端到端回归（可选，需要本机 Chrome）
 *
 * 用法：  node tools/verify-browser.mjs
 * 依赖：  Google Chrome（macOS 默认路径；可用 CHROME 环境变量覆盖）
 *         python3（用于起一个本地 HTTP 服务，验证 hospitals.json 能真实加载）
 *
 * 覆盖：
 *   A. 孕期路径（临床孕周、红旗分诊、化验单换算与规则、设置回推 LMP、9 个 tab）
 *   B. 过期妊娠与产后兜底（预产期当天不再显示"已出生"、42 周才转产后）
 *   C. 妊娠结束路径（停止推送孕期内容、随访清单、hCG 平台/上升的急救规则）
 *
 * 与 tools/verify.mjs 的分工：verify.mjs 是纯逻辑离线回归（无依赖，必跑）；
 * 本脚本验证真实 DOM/CSS/交互与 HTTP 资源加载，可选跑。
 * 退出码：0 = 全部通过；1 = 有失败项。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) {
  console.error(`未找到 Chrome：${CHROME}\n可用 CHROME=/path/to/chrome 指定，或跳过本脚本（离线回归请用 tools/verify.mjs）。`);
  process.exit(2);
}
const DP_PORT = 9377, HTTP_PORT = Number(process.env.PORT || 8795);
const SHOT_DIR = process.env.SHOT_DIR || '';
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0; const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓ ' + name + (typeof actual === 'boolean' ? '' : ' = ' + JSON.stringify(actual))); return; }
  failures.push(`${name}\n     实际 = ${JSON.stringify(actual)}\n     期望 = ${JSON.stringify(expected)}`);
  console.log('  ✗ ' + name + '\n     实际 = ' + JSON.stringify(actual) + '\n     期望 = ' + JSON.stringify(expected));
};
const group = t => console.log(`\n▸ ${t}`);

const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
await sleep(900);
const BASE = `http://127.0.0.1:${HTTP_PORT}/index.html`;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DP_PORT}`, '--user-data-dir=/tmp/cdp-huaiyun-verify',
  '--window-size=430,1500', `${BASE}?lmp=2026-07-26`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DP_PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes('index.html'));
  } catch { /* 还没起来 */ }
}
if (!target) { console.error('无法连接 Chrome'); chrome.kill(); server.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map(); const jsErrors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise(res => { const i = ++mid; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'THREW: ' + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
/* 相对今天的 YYYY-MM-DD：夹具不能写死日期，否则会随时间/时区失效 */
const dayISO = off => {
  const d = new Date(); d.setDate(d.getDate() + off);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const shot = async name => {
  if (!SHOT_DIR) return;
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (r.result?.data) fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'));
};
const reloadWith = async url => { await send('Page.navigate', { url }); await sleep(1600); };
const setStateAndReload = async state => {
  await ev(`localStorage.setItem('pregnancy-companion-v1', ${JSON.stringify(JSON.stringify(state))})`);
  await send('Page.navigate', { url: BASE });
  await sleep(1600);
};
const clickTab = async t => { await ev(`document.querySelector('#tabBar .tab[data-tab="${t}"]').click()`); await sleep(300); };
const panel = () => ev('document.getElementById("panelRoot").textContent');

await send('Runtime.enable'); await send('Page.enable');
/* 复用同一个 user-data-dir 时，Chrome 可能直接命中磁盘缓存里的旧 index.html，
   导致"改完代码但测试仍看到旧版"。这里强制禁用缓存。 */
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await sleep(1200);
/* 清掉上一次运行留下的 localStorage */
await ev('localStorage.clear()');
await send('Page.navigate', { url: `${BASE}?lmp=2026-07-26` });
await sleep(1600);

/* ---------------- A. 孕期路径 ---------------- */
group('A. 孕期路径（?lmp=2026-07-26）');
check('头部为临床孕周+天数', /孕 \d+ 周 \d+ 天/.test(await ev('document.getElementById("metaLine").textContent')), true);
check('预产期 = LMP + 280 天', await ev('document.getElementById("dueDate").textContent'), '2027-05-02');
check('顶部有红旗分诊卡', (await ev('document.body.innerHTML')).includes('哪些情况要立刻就医'), true);
check('红旗卡含宫外孕说明', (await ev('document.querySelector(".rf-card").textContent')).includes('排除宫外孕'), true);
check('红旗卡三档齐全', await ev(`(() => {
  const t = document.querySelector('.rf-card').textContent;
  return t.includes('打 120') && t.includes('立即急诊') && t.includes('24h 内门诊');
})()`), true);
await shot('shot-pregnancy.png');

group('A2. 化验单（用 276 IU/L / 14.16 nmol/L 的真实数据）');
await clickTab('lab');
await ev(`(() => {
  document.getElementById('labDate').value = '2026-09-29';
  document.getElementById('labHcg').value = '276';
  document.getElementById('labProg').value = '14.16';
  document.getElementById('labUnit').value = 'nmol/L';
  document.getElementById('labAdd').click();
})()`);
await sleep(400);
const lab = await panel();
check('已写入 localStorage', await ev('JSON.parse(localStorage.getItem("pregnancy-companion-v1")).labs.length'), 1);
check('IU/L 与 mIU/mL 等价展示', lab.includes('mIU/mL'), true);
check('孕酮自动换算 4.45 ng/mL', lab.includes('4.45 ng/mL'), true);
check('命中 hCG<1500 无法定位', lab.includes('单次 hCG 无法判断妊娠位置'), true);
check('命中孕酮偏低', lab.includes('47.7 nmol/L'), true);
await shot('shot-lab.png');

group('A3. 周历按临床孕周编号');
await clickTab('week');
check('40 周 + 月子 = 41 格', await ev('document.querySelectorAll(".week-cell").length'), 41);
check('高亮格为当前孕周', await ev('document.querySelector(".week-cell.current .num").textContent'), await ev('String(Math.floor((new Date() - new Date("2026-07-26T00:00:00"))/86400000/7))'));

group('A4. 设置页：按医生核定孕周回推 LMP');
await ev('document.getElementById("settingsBtn").click()'); await sleep(300);
await ev(`(() => {
  document.querySelector('#datingSeg .seg-btn[data-mode="week"]').click();
  document.getElementById('weekInput').value = '9';
  document.getElementById('dayInput').value = '3';
  document.getElementById('weekInputDate').value = '2026-09-30';
  document.getElementById('startBtn').click();
})()`);
await sleep(500);
check('回推 LMP = 2026-07-26', await ev('JSON.parse(localStorage.getItem("pregnancy-companion-v1")).lmp'), '2026-07-26');
check('化验单记录未因保存设置而丢失', await ev('JSON.parse(localStorage.getItem("pregnancy-companion-v1")).labs.length'), 1);

group('A5. 所有 tab 可渲染');
for (const t of ['today', 'lab', 'week', 'food', 'med', 'bag', 'sz', 'hospital', 'post']) {
  await clickTab(t);
  check(`tab ${t}`, (await ev('document.getElementById("panelRoot").innerHTML.length')) > 500, true);
}
await clickTab('hospital');
await sleep(900);   /* hospitals.json 是异步加载的，加载完成后会自行重渲染 */
check('医院数据在 HTTP 下真实加载', (await panel()).includes('深圳市妇幼保健院'), true);

/* ---------------- B. 过期妊娠 / 产后 ---------------- */
group('B. 过期妊娠（预产期已过、未满 42 周）');
await reloadWith(`${BASE}?lmp=2025-12-23`);
const overdueMeta = await ev('document.getElementById("metaLine").textContent');
check('仍显示孕期而非产后', overdueMeta.includes('孕 40 周'), true);
const overdueBody = await panel();
check('出现"已到预产期"提醒', overdueBody.includes('已到预产期'), true);
check('提醒含引产评估', overdueBody.includes('引产'), true);
check('提醒含分娩日期入口', overdueBody.includes('出生日期'), true);
check('进度卡仍在（未结束）', await ev('getComputedStyle(document.querySelector(".progress-card")).display') !== 'none', true);

group('B2. 超过 42 周兜底为产后');
await reloadWith(`${BASE}?lmp=2025-12-01`);
check('头部为产后', (await ev('document.getElementById("metaLine").textContent')).includes('产后第'), true);
check('清单切换为产后', (await panel()).includes('按需哺乳'), true);

/* ---------------- C. 妊娠结束 ---------------- */
group('C. 妊娠结束（生化妊娠，hCG 未降反升）');
await setStateAndReload({
  lmp: '2026-07-26', dating: 'lmp', profile: { pcos: true },
  outcome: { type: 'biochemical', date: dayISO(-1) },
  labs: [
    { id: 'a', date: dayISO(-4), hcg: 276, prog: 14.16, progUnit: 'nmol/L' },
    { id: 'b', date: dayISO(-1), hcg: 95, prog: 0, progUnit: 'nmol/L' },
    { id: 'c', date: dayISO(0), hcg: 130, prog: 0, progUnit: 'nmol/L' },
  ],
});
const endMeta = await ev('document.getElementById("metaLine").textContent');
check('头部显示结局而非孕周', endMeta.includes('生化妊娠') && !endMeta.includes('孕 '), true);
check('头部显示结束天数', /第 \d+ 天/.test(endMeta), true);
check('隐藏预产期/倒计时卡', await ev('getComputedStyle(document.querySelector(".progress-card")).display'), 'none');
check('隐藏周历 tab', await ev('document.querySelector(\'#tabBar .tab[data-tab="week"]\') === null'), true);
check('隐藏产后月子 tab', await ev('document.querySelector(\'#tabBar .tab[data-tab="post"]\') === null'), true);
check('出现恢复·备孕 tab', await ev('document.querySelector(\'#tabBar .tab[data-tab="after"]\') !== null'), true);
const rec = await panel();
check('今日改为随访版', rec.includes('现在要做的随访'), true);
check('不再出现胎儿发育内容', rec.includes('宝宝本周') || rec.includes('数胎动'), false);
check('给出"这不是你的错"', rec.includes('这不是你的错'), true);
check('今日含 hCG 随访摘要', rec.includes('hCG 随访：'), true);
await shot('shot-recovery.png');

group('C2. hCG 上升 → 立即就诊 + 不排复查日期（救命规则）');
await clickTab('lab');
const labAfter = await panel();
check('命中"没有继续下降"', labAfter.includes('没有继续下降'), true);
check('命中"立即就诊 + 持续性异位妊娠"', labAfter.includes('立即就诊') && labAfter.includes('持续性异位妊娠'), true);
check('换成结束后的 hCG 说明卡', labAfter.includes('结束后的 hCG 该怎么看'), true);
check('不再显示孕期口径说明卡', labAfter.includes('看这类单子要注意的 5 件事'), false);
check('出现随访时间表', labAfter.includes('随访时间表'), true);
check('时间表标注第一次 hCG', labAfter.includes('第一次 hCG'), true);
check('每条记录显示距首次/距上次', labAfter.includes('距首次 hCG') && labAfter.includes('距上一次'), true);
check('hCG 上升时不排复查日期', labAfter.includes('不排复查日期'), true);
check('说明卡含间隔分档 48–72 小时 / 每周 1 次', labAfter.includes('48–72 小时') && labAfter.includes('每周 1 次'), true);
check('说明卡含 21%–35% 判读标准', labAfter.includes('21%–35%'), true);
await shot('shot-lab-after.png');

group('C2b. 正常下降 → 自动算出下次复查日期与所需时间');
await setStateAndReload({
  lmp: '2026-07-26', dating: 'lmp', profile: {},
  outcome: { type: 'biochemical', date: dayISO(-5) },
  labs: [
    { id: 'a', date: dayISO(-6), hcg: 276, prog: 0, progUnit: 'nmol/L' },
    { id: 'b', date: dayISO(-3), hcg: 95, prog: 0, progUnit: 'nmol/L' },
    { id: 'c', date: dayISO(-1), hcg: 40, prog: 0, progUnit: 'nmol/L' },
  ],
});
await clickTab('lab');
const labAfter2 = await panel();
check('下降顺利被判为符合范围', labAfter2.includes('符合常见的 21%–35%'), true);
check('时间表含首次 hCG 的日期', labAfter2.includes(dayISO(-6)), true);
check('下次复查 = 最近一次 + 7 天', labAfter2.includes(dayISO(6)), true);
check('给出还需多久到达标', /还需[^<]*天/.test(labAfter2), true);
await shot('shot-lab-timeline.png');

group('C2c. 记录日期填在未来 → 明确提示而不是负天数');
await setStateAndReload({
  lmp: '2026-07-26', dating: 'lmp', profile: {},
  outcome: { type: 'biochemical', date: dayISO(-1) },
  labs: [{ id: 'a', date: dayISO(5), hcg: 40, prog: 0, progUnit: 'nmol/L' }],
});
await clickTab('lab');
const labFuture = await panel();
check('未来日期给出提示', labFuture.includes('日期在今天之后'), true);
check('未来日期不显示负天数', /距今天 -\d+ 天/.test(labFuture), false);

group('C3. 恢复·备孕页（对齐 docs/03、07、09）');
await setStateAndReload({
  lmp: '2026-07-26', dating: 'lmp', profile: {},
  outcome: { type: 'biochemical', date: dayISO(-1) },
  labs: [
    { id: 'a', date: dayISO(-4), hcg: 276, prog: 0, progUnit: 'nmol/L' },
    { id: 'b', date: dayISO(-1), hcg: 95, prog: 0, progUnit: 'nmol/L' },
  ],
});
await clickTab('after');
const after = await panel();
for (const [name, needle] of [
  ['hCG 复查到 <5', 'hCG 复查到 < 5 IU/L'],
  ['间隔分档 48–72 小时 / 每周', '48–72 小时'],
  ['下降判读 21%–35%', '21%–35%'],
  ['ASRM 2026 ≥2 次即可评估', '≥2 次妊娠失败'],
  ['定义含生化妊娠', '含生化妊娠'],
  ['不推荐 NK 细胞', 'NK 细胞'],
  ['不推荐 MTHFR', 'MTHFR'],
  ['不推荐 IVIg', 'IVIg'],
  ['不推荐父方白细胞免疫治疗', '父方白细胞'],
  ['再备孕时机', '1–2 次正常月经'],
  ['情绪求助阈值', '持续 2 周以上'],
  ['下次备孕必查地贫', '地中海贫血'],
  ['提示同时做 B 超', '经阴道 B 超'],
]) check(name, after.includes(needle), true);
await shot('shot-after.png');

group('C4. 设置页可回显与清除结局');
await ev('document.getElementById("settingsBtn").click()'); await sleep(300);
check('下拉含 5 类结局', await ev('document.getElementById("outcomeType").options.length'), 6);
check('回显结局类型', await ev('document.getElementById("outcomeType").value'), 'biochemical');
check('回显结局日期', await ev('document.getElementById("outcomeDate").value'), dayISO(-1));
await ev(`(() => {
  document.getElementById('outcomeType').value = '';
  document.getElementById('outcomeDate').value = '';
  document.getElementById('startBtn').click();
})()`);
await sleep(600);
check('清除后回到孕期内容', (await panel()).includes('宝宝本周'), true);
check('清除后周历 tab 恢复', await ev('document.querySelector(\'#tabBar .tab[data-tab="week"]\') !== null'), true);
check('清除后化验单记录仍在', await ev('JSON.parse(localStorage.getItem("pregnancy-companion-v1")).labs.length'), 2);

group('D. 控制台');
check('无 JS 异常', jsErrors, []);

console.log('\n' + '─'.repeat(58));
if (failures.length) {
  console.log(`✗ 浏览器端 ${failures.length} 项失败 / ${pass} 项通过\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  ws.close(); chrome.kill(); server.kill();
  process.exit(1);
}
console.log(`✓ 浏览器端全部通过：${pass} 项检查`);
ws.close(); chrome.kill(); server.kill();
process.exit(0);
