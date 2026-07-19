// 동행복권 로또 6/45 데이터 갱신 스크립트
// 사용법: node update-data.mjs
// 조회 범위는 제1회(고정) ~ 최신 회차(사이트에서 자동 감지)이며,
// data/draws.json 에 이미 받은 회차는 건너뛰고 새 회차만 받아 index.html 에 반영합니다.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "draws.json");
const HTML_PATH = path.join(ROOT, "index.html");

const BASE = "https://www.dhlottery.co.kr/lt645/selectPstLt645InfoNew.do";
const HDRS = { "User-Agent": "Mozilla/5.0", Referer: "https://www.dhlottery.co.kr/lt645/result" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchList = async (params) => {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: HDRS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const json = await res.json();
  return json?.data?.list ?? [];
};

const toDraw = (x) => ({
  round: x.ltEpsd,
  date: x.ltRflYmd,
  nums: [x.tm1WnNo, x.tm2WnNo, x.tm3WnNo, x.tm4WnNo, x.tm5WnNo, x.tm6WnNo],
  bonus: x.bnsWnNo,
  w1: x.rnk1WnNope,
  w2: x.rnk2WnNope,
  w3: x.rnk3WnNope,
  sales: x.wholEpsdSumNtslAmt,
});

// cursor 초과(더 새로운) 회차 묶음 — 한 번에 최대 10회차, 없으면 빈 배열
const fetchNewer = async (cursor) =>
  (await fetchList({ srchDir: "latest", srchCursorLtEpsd: String(cursor) })).map(toDraw);

// 제1회 부근 시드 (첫 수집 시)
const fetchFirst = async () =>
  (await fetchList({ srchDir: "center", srchLtEpsd: "1" })).map(toDraw);

const collect = async () => {
  const all = new Map();
  if (fs.existsSync(DRAWS_PATH)) {
    const cached = JSON.parse(fs.readFileSync(DRAWS_PATH, "utf8"));
    // 구버전 캐시(당첨자 수·판매액 없음)면 전체 재수집
    if (cached.length && cached[0].sales !== undefined) {
      for (const d of cached) all.set(d.round, d);
    } else if (cached.length) {
      console.log("구버전 캐시 감지 — 당첨자 수 포함 전체 재수집");
    }
  }
  const cachedMax = all.size ? Math.max(...all.keys()) : 0;
  console.log(cachedMax ? `캐시: 제1회 ~ 제${cachedMax}회` : "캐시 없음 — 제1회부터 전체 수집");

  let cursor = cachedMax;
  if (!cursor) {
    const seed = await fetchFirst();
    if (!seed.length) throw new Error("제1회 조회 실패");
    seed.forEach((d) => all.set(d.round, d));
    cursor = Math.max(...seed.map((d) => d.round));
  }

  // 최신 회차는 사이트가 알려줄 때까지(빈 응답) 위로 걷기 — 조회 범위: 제1회(고정) ~ 최신
  while (true) {
    const list = await fetchNewer(cursor);
    if (!list.length) break;
    list.forEach((d) => all.set(d.round, d));
    const max = Math.max(...list.map((d) => d.round));
    if (max <= cursor) break;
    cursor = max;
    if (cursor % 100 < 10) console.log(`수집 중… 제${cursor}회`);
    await sleep(120);
  }

  const latestRound = Math.max(...all.keys());
  console.log(`최신 회차: 제${latestRound}회`);
  const missing = [];
  for (let r = 1; r <= latestRound; r++) if (!all.has(r)) missing.push(r);
  if (missing.length) throw new Error(`누락 회차: ${missing.join(", ")} — data/draws.json 삭제 후 재실행하세요`);
  return [...all.values()].sort((a, b) => a.round - b.round);
};

const buildStats = (rounds) => {
  const freq = Array(45).fill(0);
  const last = Array(45).fill(0);
  rounds.forEach((r) => r.nums.forEach((n) => { freq[n - 1]++; last[n - 1] = r.round; }));
  const latest = rounds[rounds.length - 1];
  const meta = {
    latestRound: latest.round,
    latestDate: `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}`,
    latestNums: latest.nums,
    latestBonus: latest.bonus,
    total: rounds.length,
  };
  return { meta, freq, last };
};

// ---------- 인기도 회귀 모델 ----------
// 타깃: 회차별 log(3등(5개 일치) 당첨자 수 / 판매 게임 수)
//   → 그 회차 당첨 조합을 "사람들이 얼마나 골랐는가"의 관측치
// 페이지의 featuresOf 와 반드시 동일하게 유지할 것
const featuresOf = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const low31 = s.filter((n) => n <= 31).length;
  const forty = s.filter((n) => n >= 40).length;
  let consec = 0;
  for (let i = 1; i < 6; i++) if (s[i] - s[i - 1] === 1) consec++;
  const ld = {};
  s.forEach((n) => { ld[n % 10] = (ld[n % 10] || 0) + 1; });
  const sameLd = Math.max(...Object.values(ld));
  const spread = s[5] - s[0];
  const has7 = s.includes(7) ? 1 : 0;
  return [low31, sum, consec, forty, sameLd, spread, has7];
};

const FEAT_NAMES = ["31이하 개수", "합계", "연속쌍", "40이상 개수", "동일끝자리 최대", "범위", "7 포함"];
const TRAIN_WINDOW = 520; // 최근 10년치만 학습 (게임 가격·구매 성향 균질 구간)

// (X'X + λI) b = X'y 가우스 소거
const solve = (A, y) => {
  const n = A.length;
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || M[c][c] === 0) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
};

const trainModel = (rounds) => {
  const train = rounds
    .slice(-TRAIN_WINDOW)
    .filter((r) => r.w3 > 0 && r.sales > 0);
  const rawX = train.map((r) => featuresOf(r.nums));
  const y = train.map((r) => Math.log(r.w3 / (r.sales / 1000)));

  const k = rawX[0].length;
  const mu = Array(k).fill(0), sd = Array(k).fill(0);
  rawX.forEach((f) => f.forEach((v, j) => { mu[j] += v; }));
  mu.forEach((v, j) => { mu[j] = v / rawX.length; });
  rawX.forEach((f) => f.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2; }));
  sd.forEach((v, j) => { sd[j] = Math.sqrt(v / rawX.length) || 1; });

  const X = rawX.map((f) => [1, ...f.map((v, j) => (v - mu[j]) / sd[j])]);
  const d = k + 1;
  const XtX = Array.from({ length: d }, () => Array(d).fill(0));
  const Xty = Array(d).fill(0);
  X.forEach((row, i) => {
    for (let a = 0; a < d; a++) {
      Xty[a] += row[a] * y[i];
      for (let b = 0; b < d; b++) XtX[a][b] += row[a] * row[b];
    }
  });
  const lambda = 1e-3 * X.length;
  for (let a = 1; a < d; a++) XtX[a][a] += lambda;
  const beta = solve(XtX, Xty);

  const yMean = y.reduce((a, b) => a + b, 0) / y.length;
  let ssRes = 0, ssTot = 0;
  X.forEach((row, i) => {
    const pred = row.reduce((acc, v, j) => acc + v * beta[j], 0);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  });
  const r2 = 1 - ssRes / ssTot;
  return { mu, sd, beta: beta.map((b) => +b.toFixed(6)), n: X.length, r2: +r2.toFixed(4) };
};

// UI 문구(회차·기준일·모델 성능)는 페이지가 META/MODEL 에서 직접 렌더링하므로
// 여기서는 DATA 구간만 갈아끼우면 된다
const patchHtml = ({ meta, freq, last }, model) => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const block =
    `/* DATA:BEGIN — node update-data.mjs 로 자동 갱신되는 구간 */\n` +
    `  const META = ${JSON.stringify(meta)};\n` +
    `  const FREQ = ${JSON.stringify(freq)};\n` +
    `  const LAST = ${JSON.stringify(last)};\n` +
    `  const MODEL = ${JSON.stringify(model)};\n` +
    `  /* DATA:END */`;
  const re = /\/\* DATA:BEGIN[\s\S]*?DATA:END \*\//;
  if (!re.test(html)) throw new Error("index.html 에서 DATA 구간을 찾지 못했습니다");
  fs.writeFileSync(HTML_PATH, html.replace(re, block));
};

const main = async () => {
  const rounds = await collect();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DRAWS_PATH, JSON.stringify(rounds));
  const stats = buildStats(rounds);
  const model = trainModel(rounds);
  patchHtml(stats, model);
  console.log(`완료: 제1회 ~ 제${stats.meta.latestRound}회 (총 ${stats.meta.total}회차) 반영`);
  const least = Array.from({ length: 45 }, (_, i) => i + 1)
    .sort((a, b) => (stats.freq[a - 1] - stats.freq[b - 1]) || (a - b))
    .slice(0, 10);
  console.log(`최소 출현 TOP 10: ${least.map((n) => `${n}(${stats.freq[n - 1]}회)`).join(", ")}`);
  console.log(`인기도 모델: 학습 ${model.n}회차, R²=${model.r2}`);
  model.beta.slice(1).forEach((b, j) => console.log(`  ${FEAT_NAMES[j]}: ${b > 0 ? "+" : ""}${b}`));
};

main().catch((e) => { console.error(e.message); process.exit(1); });
