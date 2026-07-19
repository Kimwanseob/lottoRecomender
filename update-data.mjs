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
    for (const d of JSON.parse(fs.readFileSync(DRAWS_PATH, "utf8"))) all.set(d.round, d);
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

const patchHtml = ({ meta, freq, last }) => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const block =
    `/* DATA:BEGIN — node update-data.mjs 로 자동 갱신되는 구간 */\n` +
    `  const META = ${JSON.stringify(meta)};\n` +
    `  const FREQ = ${JSON.stringify(freq)};\n` +
    `  const LAST = ${JSON.stringify(last)};\n` +
    `  /* DATA:END */`;
  const re = /\/\* DATA:BEGIN[\s\S]*?DATA:END \*\//;
  if (!re.test(html)) throw new Error("index.html 에서 DATA 구간을 찾지 못했습니다");
  let out = html.replace(re, block);
  out = out.replace(/제1회 – 제\d+회 전 회차 분석/, `제1회 – 제${meta.latestRound}회 전 회차 분석`);
  out = out.replace(/제\d+회\(\d{4}-\d{2}-\d{2} 추첨\)까지 반영/, `제${meta.latestRound}회(${meta.latestDate} 추첨)까지 반영`);
  out = out.replace(/[\d,]+회 동안 본번호로/, `${meta.total.toLocaleString("ko-KR")}회 동안 본번호로`);
  fs.writeFileSync(HTML_PATH, out);
};

const main = async () => {
  const rounds = await collect();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DRAWS_PATH, JSON.stringify(rounds));
  const stats = buildStats(rounds);
  patchHtml(stats);
  console.log(`완료: 제1회 ~ 제${stats.meta.latestRound}회 (총 ${stats.meta.total}회차) 반영`);
  const least = Array.from({ length: 45 }, (_, i) => i + 1)
    .sort((a, b) => (stats.freq[a - 1] - stats.freq[b - 1]) || (a - b))
    .slice(0, 10);
  console.log(`최소 출현 TOP 10: ${least.map((n) => `${n}(${stats.freq[n - 1]}회)`).join(", ")}`);
};

main().catch((e) => { console.error(e.message); process.exit(1); });
